// 개발 설치본의 Electron 포장과 Windows 설치 파일 설정을 지정한다.
const { join } = require('node:path');

const resourceRoot = process.env.CHECKMATE_BUILD_RESOURCE_ROOT;
if (!resourceRoot) throw new Error('개발 설치본 리소스 경로가 없습니다. scripts/개발설치본.mjs를 실행해 주세요.');
const thumbprint = process.env.CHECKMATE_SIGN_THUMBPRINT;
if (thumbprint && !/^[A-Fa-f0-9]{40}$/.test(thumbprint)) throw new Error('서명 인증서 지문이 올바르지 않습니다.');
const windowsSign = thumbprint ? { hashes: ['sha256'], timestampServer: 'http://timestamp.digicert.com', signWithParams: ['/sha1', thumbprint, '/s', 'My'] } : undefined;

module.exports = {
  packagerConfig: {
    asar: true,
    windowsSign,
    prune: false,
    executableName: 'CheckMate',
    extraResource: [join(resourceRoot, 'node'), join(resourceRoot, 'engine')],
  },
  rebuildConfig: { onlyModules: [] },
  makers: [{
    name: '@electron-forge/maker-squirrel',
    config: {
      name: 'CheckMate',
      windowsSign,
      authors: 'yeunlee1',
      description: 'Local software verification for developers and AI coding agents.',
      setupExe: 'CheckMate-개발설치.exe',
      appUserModelId: 'com.squirrel.CheckMate.CheckMate',
      additionalFiles: [{ src: 'LICENSES.chromium.html', target: 'lib\\net45\\LICENSES.chromium.html' },
        { src: 'version', target: 'lib\\net45\\version' }],
      vendorDirectory: join(resourceRoot, '..', 'squirrel-vendor'),
    },
  }],
};
