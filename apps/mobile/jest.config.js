module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
    '^@react-native-clipboard/clipboard$': '<rootDir>/src/test/helpers/ClipboardMock.ts',
  },
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native|react-native-markdown-display|react-native-fit-image)/)'],
};
