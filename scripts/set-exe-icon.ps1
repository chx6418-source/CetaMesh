param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$IconPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path

# IExpress does not expose a custom-icon setting. Replace every RT_GROUP_ICON
# resource after packaging, while preserving the executable payload and its
# existing resource languages. This must run before Authenticode signing.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class WhaleBridgeIconResource
{
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private const ushort RT_ICON = 3;
    private const ushort RT_GROUP_ICON = 14;
    private const ushort FIRST_ICON_ID = 32000;

    private sealed class ResourceTarget
    {
        public bool IsInteger;
        public ushort Id;
        public string Name;
        public ushort Language;
    }

    private static readonly List<ResourceTarget> GroupTargets = new List<ResourceTarget>();

    private delegate bool EnumResourceNamesDelegate(
        IntPtr module,
        IntPtr type,
        IntPtr name,
        IntPtr parameter);

    private delegate bool EnumResourceLanguagesDelegate(
        IntPtr module,
        IntPtr type,
        IntPtr name,
        ushort language,
        IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumResourceNamesW(
        IntPtr module,
        IntPtr type,
        EnumResourceNamesDelegate callback,
        IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumResourceLanguagesW(
        IntPtr module,
        IntPtr type,
        IntPtr name,
        EnumResourceLanguagesDelegate callback,
        IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResourceW(string fileName, [MarshalAs(UnmanagedType.Bool)] bool deleteExistingResources);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateResourceW(
        IntPtr update,
        IntPtr type,
        IntPtr name,
        ushort language,
        byte[] data,
        uint dataSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndUpdateResourceW(IntPtr update, [MarshalAs(UnmanagedType.Bool)] bool discard);

    private static IntPtr IntegerResource(ushort id)
    {
        return new IntPtr(id);
    }

    private static bool IsIntegerResource(IntPtr value)
    {
        return ((ulong)value.ToInt64() >> 16) == 0;
    }

    private static bool EnumerateLanguages(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter)
    {
        EnumResourceLanguagesDelegate languageCallback = delegate(
            IntPtr innerModule,
            IntPtr innerType,
            IntPtr innerName,
            ushort language,
            IntPtr innerParameter)
        {
            ResourceTarget target = new ResourceTarget();
            target.Language = language;
            target.IsInteger = IsIntegerResource(innerName);
            if (target.IsInteger)
            {
                target.Id = unchecked((ushort)innerName.ToInt64());
                target.Name = null;
            }
            else
            {
                target.Name = Marshal.PtrToStringUni(innerName);
            }
            GroupTargets.Add(target);
            return true;
        };

        bool result = EnumResourceLanguagesW(module, type, name, languageCallback, IntPtr.Zero);
        GC.KeepAlive(languageCallback);
        return result;
    }

    private static List<ResourceTarget> ReadGroupTargets(string executablePath)
    {
        GroupTargets.Clear();
        IntPtr module = LoadLibraryExW(executablePath, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to load executable resources");
        }

        try
        {
            EnumResourceNamesDelegate nameCallback = EnumerateLanguages;
            bool result = EnumResourceNamesW(module, IntegerResource(RT_GROUP_ICON), nameCallback, IntPtr.Zero);
            int error = Marshal.GetLastWin32Error();
            GC.KeepAlive(nameCallback);

            // ERROR_RESOURCE_TYPE_NOT_FOUND means the executable had no icon.
            if (!result && error != 1813)
            {
                throw new Win32Exception(error, "Unable to enumerate icon resources");
            }

            return new List<ResourceTarget>(GroupTargets);
        }
        finally
        {
            FreeLibrary(module);
        }
    }

    private static ushort ReadUInt16(byte[] data, int offset)
    {
        return (ushort)(data[offset] | (data[offset + 1] << 8));
    }

    private static uint ReadUInt32(byte[] data, int offset)
    {
        return (uint)(data[offset]
            | (data[offset + 1] << 8)
            | (data[offset + 2] << 16)
            | (data[offset + 3] << 24));
    }

    private static void WriteUInt16(byte[] data, int offset, ushort value)
    {
        data[offset] = (byte)value;
        data[offset + 1] = (byte)(value >> 8);
    }

    private static void WriteUInt32(byte[] data, int offset, uint value)
    {
        data[offset] = (byte)value;
        data[offset + 1] = (byte)(value >> 8);
        data[offset + 2] = (byte)(value >> 16);
        data[offset + 3] = (byte)(value >> 24);
    }

    private sealed class IconImage
    {
        public byte Width;
        public byte Height;
        public byte ColorCount;
        public byte Reserved;
        public ushort Planes;
        public ushort BitCount;
        public byte[] Data;
        public ushort ResourceId;
    }

    private static List<IconImage> ReadIcon(string iconPath)
    {
        byte[] icon = File.ReadAllBytes(iconPath);
        if (icon.Length < 6 || ReadUInt16(icon, 0) != 0 || ReadUInt16(icon, 2) != 1)
        {
            throw new InvalidDataException("The source file is not a Windows icon");
        }

        ushort count = ReadUInt16(icon, 4);
        if (count == 0 || icon.Length < 6 + count * 16)
        {
            throw new InvalidDataException("The source icon directory is incomplete");
        }

        List<IconImage> images = new List<IconImage>();
        for (int index = 0; index < count; index++)
        {
            int entryOffset = 6 + index * 16;
            uint length = ReadUInt32(icon, entryOffset + 8);
            uint offset = ReadUInt32(icon, entryOffset + 12);
            if (length == 0 || offset > (uint)icon.Length || length > (uint)icon.Length - offset)
            {
                throw new InvalidDataException("An icon image points outside the source file");
            }

            byte[] imageData = new byte[(int)length];
            Buffer.BlockCopy(icon, (int)offset, imageData, 0, (int)length);
            images.Add(new IconImage
            {
                Width = icon[entryOffset],
                Height = icon[entryOffset + 1],
                ColorCount = icon[entryOffset + 2],
                Reserved = icon[entryOffset + 3],
                Planes = ReadUInt16(icon, entryOffset + 4),
                BitCount = ReadUInt16(icon, entryOffset + 6),
                Data = imageData,
                ResourceId = (ushort)(FIRST_ICON_ID + index)
            });
        }
        return images;
    }

    private static byte[] BuildGroupIcon(List<IconImage> images)
    {
        byte[] group = new byte[6 + images.Count * 14];
        WriteUInt16(group, 0, 0);
        WriteUInt16(group, 2, 1);
        WriteUInt16(group, 4, (ushort)images.Count);
        for (int index = 0; index < images.Count; index++)
        {
            IconImage image = images[index];
            int offset = 6 + index * 14;
            group[offset] = image.Width;
            group[offset + 1] = image.Height;
            group[offset + 2] = image.ColorCount;
            group[offset + 3] = image.Reserved;
            WriteUInt16(group, offset + 4, image.Planes);
            WriteUInt16(group, offset + 6, image.BitCount);
            WriteUInt32(group, offset + 8, (uint)image.Data.Length);
            WriteUInt16(group, offset + 12, image.ResourceId);
        }
        return group;
    }

    private static IntPtr AllocateResourceName(ResourceTarget target)
    {
        return target.IsInteger ? IntegerResource(target.Id) : Marshal.StringToHGlobalUni(target.Name);
    }

    public static int Apply(string executablePath, string iconPath)
    {
        List<ResourceTarget> targets = ReadGroupTargets(executablePath);
        if (targets.Count == 0)
        {
            targets.Add(new ResourceTarget { IsInteger = true, Id = 1, Language = 0 });
        }

        List<IconImage> images = ReadIcon(iconPath);
        byte[] groupData = BuildGroupIcon(images);
        IntPtr update = BeginUpdateResourceW(executablePath, false);
        if (update == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to begin updating executable resources");
        }

        bool committed = false;
        try
        {
            HashSet<ushort> languages = new HashSet<ushort>();
            foreach (ResourceTarget target in targets)
            {
                languages.Add(target.Language);
            }

            foreach (ushort language in languages)
            {
                foreach (IconImage image in images)
                {
                    if (!UpdateResourceW(update, IntegerResource(RT_ICON), IntegerResource(image.ResourceId),
                        language, image.Data, (uint)image.Data.Length))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to write an icon image resource");
                    }
                }
            }

            foreach (ResourceTarget target in targets)
            {
                IntPtr name = AllocateResourceName(target);
                try
                {
                    if (!UpdateResourceW(update, IntegerResource(RT_GROUP_ICON), name,
                        target.Language, groupData, (uint)groupData.Length))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to write the icon group resource");
                    }
                }
                finally
                {
                    if (!target.IsInteger) Marshal.FreeHGlobal(name);
                }
            }

            if (!EndUpdateResourceW(update, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to commit executable resources");
            }
            committed = true;
            return targets.Count;
        }
        finally
        {
            if (!committed) EndUpdateResourceW(update, true);
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp
$updatedGroups = [WhaleBridgeIconResource]::Apply($resolvedExecutable, $resolvedIcon)
Write-Output "Updated $updatedGroups icon resource group(s) in $resolvedExecutable"
