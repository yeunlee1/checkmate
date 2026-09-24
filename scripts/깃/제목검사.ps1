# 커밋과 풀 리퀘스트 제목의 한국어 설명을 검사한다.
param(
    [string] $Title,
    [string] $CommitMessageFile,
    [string] $ReferenceName
)

$ErrorActionPreference = 'Stop'

if ($CommitMessageFile) {
    $messageLines = @(Get-Content -LiteralPath $CommitMessageFile -Encoding UTF8 |
        Where-Object { -not $_.StartsWith('#') -and -not [string]::IsNullOrWhiteSpace($_) })
    $Title = $messageLines | Select-Object -First 1
}

$textToCheck = if ($ReferenceName) { $ReferenceName } elseif ($CommitMessageFile) { $messageLines -join "`n" } else { $Title }
foreach ($rune in ([string] $textToCheck).EnumerateRunes()) {
    $category = [System.Text.Rune]::GetUnicodeCategory($rune).ToString()
    if ($category -notmatch 'Letter$') { continue }
    $point = $rune.Value
    $allowed = ($point -ge 0x41 -and $point -le 0x5A) -or ($point -ge 0x61 -and $point -le 0x7A) -or
        ($point -ge 0x1100 -and $point -le 0x11FF) -or ($point -ge 0x3130 -and $point -le 0x318F) -or
        ($point -ge 0xA960 -and $point -le 0xA97F) -or ($point -ge 0xAC00 -and $point -le 0xD7A3) -or
        ($point -ge 0xD7B0 -and $point -le 0xD7FF)
    if (-not $allowed) {
        Write-Host '글자는 한글과 영어만 사용할 수 있습니다. 이름과 설명을 수정해 주세요.' -ForegroundColor Red
        exit 1
    }
}
if ($ReferenceName) { exit 0 }

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
