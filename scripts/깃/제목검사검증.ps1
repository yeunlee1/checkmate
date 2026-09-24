# 제목 검사에서 허용할 한국어 제목과 거절할 잘못된 제목을 검증한다.
param()

$ErrorActionPreference = 'Stop'
$policyScript = Join-Path $PSScriptRoot '제목검사.ps1'
$passTitles = @(
    '이미지 미리보기 초록 버튼 제거',
    'SQLite 검사 이력 저장 방식 정리',
    'feat: 검사 실행 상태 표시 추가',
    'fix: 검증 결과 조회 오류 수정',
    'docs: 설치 안내와 도움말 정리',
    'refactor: 실행 관리 구조 정리',
    'refact: 실행 관리 구조 정리',
    'revert: 실행 상태 표시 변경 되돌림',
    'chore(빌드): 설치 산출물 경로 정리',
    'feat!: 검사 결과 저장 방식 변경',
    'fix : 실행 상태 표시 오류 수정',
    'chore: 깃 관리 설정을 develop에 병합'
)
$failTitles = @(
    '',
    '수정',
    'feat:',
    'fix: 수정',
    'fix: Correct verification result output',
    '검사 verification result output',
    'Merge branch develop',
    'Revert "검사 결과 표시 변경"',
    'chore: Merge branch develop',
    ('fix: 검사 결과 표시 수정 ' + [char] 0x4E00),
    ('fix: 검사 결과 표시 수정 ' + [char] 0x3042),
    ('fix: 검사 결과 표시 수정 ' + [char] 0x30A2),
    ('fix: 검사 결과 표시 수정 ' + [char]::ConvertFromUtf32(0x20000))
)

foreach ($title in $passTitles) {
    & $policyScript -Title $title *> $null
    if ($LASTEXITCODE -ne 0) { throw "허용 제목이 거절되었습니다. $title" }
}
foreach ($title in $failTitles) {
    & $policyScript -Title $title *> $null
    if ($LASTEXITCODE -eq 0) { throw "거절 제목이 허용되었습니다. $title" }
}

foreach ($reference in @('main', 'develop', 'work/2026-09-25-상세설계확정', 'refs/tags/v0.1.0')) {
    & $policyScript -ReferenceName $reference *> $null
    if ($LASTEXITCODE -ne 0) { throw '한글과 영어로 작성한 참조 이름이 거절되었습니다.' }
}
& $policyScript -ReferenceName ('work/2026-09-25-' + [char] 0x4E00) *> $null
if ($LASTEXITCODE -eq 0) { throw '허용하지 않는 글자가 포함된 참조 이름을 차단하지 못했습니다.' }

$messageFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($messageFile, "# 작성 안내`n`nfix: 검사 결과 표시 오류 수정`n`n본문은 제목 검사에 포함하지 않습니다.`n", [System.Text.UTF8Encoding]::new($true))
    & $policyScript -CommitMessageFile $messageFile *> $null
    if ($LASTEXITCODE -ne 0) { throw '주석·빈 줄·본문이 포함된 커밋 파일 검사가 실패했습니다.' }
    [System.IO.File]::AppendAllText($messageFile, [string] [char] 0x4E00, [System.Text.UTF8Encoding]::new($false))
    & $policyScript -CommitMessageFile $messageFile *> $null
    if ($LASTEXITCODE -eq 0) { throw '커밋 본문의 허용하지 않는 글자를 차단하지 못했습니다.' }
} finally {
    Remove-Item -LiteralPath $messageFile
}

Write-Host "제목 정책 검증 통과. 허용 $($passTitles.Count)건, 거절 $($failTitles.Count)건, 참조 이름 5건, 커밋 파일 2건."
exit 0
