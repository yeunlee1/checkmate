# 태그 배포 인증서를 사용자 저장소에 준비하거나 이번 작업의 인증서만 제거한다.
param([ValidateSet('prepare', 'cleanup')][string]$Mode)
$ErrorActionPreference = 'Stop'
$record = Join-Path $env:RUNNER_TEMP 'checkmate-signing-thumbprint.txt'
if ($Mode -eq 'cleanup') {
    if (Test-Path -LiteralPath $record) {
        $thumbprint = (Get-Content -LiteralPath $record -Raw).Trim()
        if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw '인증서 정리 표식이 올바르지 않습니다.' }
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -Force
        Remove-Item -LiteralPath $record -Force
    }
    exit 0
}
if (!$env:CHECKMATE_SIGN_PFX_BASE64 -or !$env:CHECKMATE_SIGN_PFX_PASSWORD) { throw '정식 배포에는 코드 서명 인증서 설정이 필요합니다.' }
$pfx = Join-Path $env:RUNNER_TEMP 'checkmate-signing.pfx'
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:CHECKMATE_SIGN_PFX_BASE64))
    $password = ConvertTo-SecureString $env:CHECKMATE_SIGN_PFX_PASSWORD -AsPlainText -Force
    $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password
    $signer = @($cert | Where-Object { $_.HasPrivateKey -and $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3' })
    if ($signer.Count -ne 1) { throw '코드 서명 인증서 한 개가 필요합니다.' }
    $thumbprint = $signer[0].Thumbprint
    Set-Content -LiteralPath $record -Value $thumbprint -NoNewline
    "CHECKMATE_SIGN_THUMBPRINT=$thumbprint" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
} finally {
    if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
}
