import {inflateSync} from 'node:zlib';

const bad = () => { throw Object.assign(new Error('图片文件类型、尺寸或编码无效'), {code:'ATTACHMENT_TYPE_MISMATCH'}); };
export function imageDimensions(b) {
  let width, height, mimeType;
  if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    width=b.readUInt32BE(16);height=b.readUInt32BE(20);mimeType='image/png';
  } else if(b.length>=30 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP') {
    const kind=b.toString('ascii',12,16);mimeType='image/webp';
    if(kind==='VP8X'){width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(kind==='VP8 '&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a){width=b.readUInt16LE(26)&16383;height=b.readUInt16LE(28)&16383;}
    else if(kind==='VP8L'&&b[20]===0x2f){const n=b.readUInt32LE(21);width=(n&16383)+1;height=((n>>>14)&16383)+1;}else bad();
  } else if(b.length>4&&b[0]===255&&b[1]===216) {
    mimeType='image/jpeg';let p=2;
    while(p+4<b.length){if(b[p++]!==255)bad();while(b[p]===255)p++;const marker=b[p++];if(marker===0xd9||marker===0xda)break;
      const len=b.readUInt16BE(p);if(len<2||p+len>b.length)bad();
      if([0xc0,0xc1,0xc2].includes(marker)){height=b.readUInt16BE(p+3);width=b.readUInt16BE(p+5);break;}p+=len;}
  } else bad();
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>16384||height>16384||width*height>40_000_000)bad();
  return {width,height,mimeType};
}
function crc32(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
/** Model versions are canonical browser-decoded PNG, independently bounded and decoded in Core. */
export function validateModelImage(b) {
  if(b.length>2*1024*1024)bad();const info=imageDimensions(b);if(info.mimeType!=='image/png'||info.width>2048||info.height>2048)bad();
  let p=8,seenHeader=false,ended=false;const chunks=[];
  while(p+12<=b.length){const n=b.readUInt32BE(p),type=b.toString('ascii',p+4,p+8);if(n>b.length-p-12)bad();
    const data=b.subarray(p+8,p+8+n);if(crc32(b.subarray(p+4,p+8+n))!==b.readUInt32BE(p+8+n))bad();
    if(!seenHeader&&type!=='IHDR')bad();
    if(type==='IHDR'){if(seenHeader||n!==13||data[8]!==8||![2,6].includes(data[9])||data[10]||data[11]||data[12])bad();seenHeader=true;}
    else if(type==='IDAT')chunks.push(data);
    else if(type==='IEND'){if(n||!chunks.length)bad();ended=true;p+=12;break;}
    else if(!['sRGB','gAMA','cHRM','pHYs'].includes(type))bad();
    p+=12+n;
  }
  if(!ended||p!==b.length)bad();const channels=b[25]===6?4:3;const row=info.width*channels+1;
  let raw;try{raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:row*info.height});}catch{bad();}
  if(raw.length!==row*info.height)bad();for(let i=0;i<info.height;i++)if(raw[i*row]>4)bad();return info;
}
