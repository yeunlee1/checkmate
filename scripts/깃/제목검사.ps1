# 커밋과 풀 리퀘스트 제목의 한국어 설명을 검사한다.
param(
    [string] $Title,
    [string] $CommitMessageFile
)

$ErrorActionPreference = 'Stop'

if ($CommitMessageFile) {
    $Title = Get-Content -LiteralPath $CommitMessageFile -Encoding UTF8 |
        Where-Object { -not $_.StartsWith('#') -and -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($Title)) {
    Write-Host '제목이 비어 있습니다. 작업 내용을 한국어로 적어 주세요.' -ForegroundColor Red
    exit 1
}

$description = $Title.Trim() -replace '(?i)^(feat|fix|docs|style|refactor|refact|test|chore|build|ci|perf|revert)(\([^)]+\))?\s*!?\s*:\s*', ''
$hangulCount = [regex]::Matches($description, '[\p{IsHangulSyllables}\p{IsHangulJamo}\p{IsHangulCompatibilityJamo}]').Count
$latinCount = [regex]::Matches($description, '[A-Za-z]').Count

if ($description -match '(?i)^(merge|revert)\b') {
    Write-Host '자동 영어 병합·되돌림 제목을 한국어 설명으로 바꿔 주세요.' -ForegroundColor Red
    exit 1
}
if ($hangulCount -lt 4) {
    Write-Host '타입 뒤 설명에 한글이 4자 이상 있어야 합니다.' -ForegroundColor Red
    exit 1
}
if ($latinCount -gt $hangulCount) {
    Write-Host '영문자가 한글보다 많습니다. 작업 내용을 한국어 중심으로 적어 주세요.' -ForegroundColor Red
    exit 1
}

exit 0
