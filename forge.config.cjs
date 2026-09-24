// 개발 설치본의 Electron 포장과 Windows 설치 파일 설정을 지정한다.
const { join } = require('node:path');

const resourceRoot = process.env.CHECKMATE_BUILD_RESOURCE_ROOT;
if (!resourceRoot) throw new Error('개발 설치본 리소스 경로가 없습니다. scripts/개발설치본.mjs를 실행해 주세요.');

module.exports = {
  packagerConfig: {
    asar: true,
    prune: false,
    executableName: 'CheckMate',
    extraResource: [join(resourceRoot, 'node'), join(resourceRoot, 'engine')],
  },
  rebuildConfig: { onlyModules: [] },
  makers: [{
    name: '@electron-forge/maker-squirrel',
    config: {
      name: 'CheckMate',
      authors: 'yeunlee1',
      description: 'Local software verification for developers and AI coding agents.',
      setupExe: 'CheckMate-개발설치.exe',
      appUserModelId: 'com.squirrel.CheckMate.CheckMate',
      vendorDirectory: join(resourceRoot, '..', 'squirrel-vendor'),
    },
  }],
};
