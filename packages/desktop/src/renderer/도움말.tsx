// 프로젝트 선택부터 실행 결과 확인까지의 사용 순서를 안내한다.
import { useLanguage, text } from './언어.js';

export function Help() {
  useLanguage();
  return <section className="panel" aria-labelledby="help-heading">
    <div className="panel-heading"><div><h2 id="help-heading">{text('체크메이트 시작하기', 'Get started with CheckMate')}</h2>
      <p>{text('프로젝트를 고르고 검사를 실행한 뒤, 결과와 근거를 확인합니다.',
        'Choose a project, run its checks, then review the result and evidence.')}</p></div></div>
    <div className="subsection"><h3>{text('첫 실행 순서', 'Your first run')}</h3>
      <ol>
        <li>{text('로컬 저장소를 준비합니다. 검사 이력을 이 컴퓨터에 보관합니다.',
          'Set up local storage. CheckMate keeps run history on this computer.')}</li>
        <li>{text('프로젝트에서 추가를 누르고 검사 원본이 있는 폴더를 고릅니다.',
          'In Projects, choose Add and select the folder containing your check files.')}</li>
        <li>{text('검사 묶음을 고르고 계획을 확인합니다. 검사 묶음은 함께 실행할 검사의 목록입니다.',
          'Choose a check set and review the plan. A check set is a list of checks to run together.')}</li>
        <li>{text('실행 명령과 파일 쓰기 범위를 읽고 승인한 뒤 검사를 시작합니다.',
          'Review the commands and files they may write, approve the plan, then start the run.')}</li>
        <li>{text('실행 결과에서 판정과 근거를 봅니다. 실패한 항목은 기대한 동작과 실제 관측을 비교하고 수정 후 다시 검사합니다.',
          'In Run Results, review the outcome and evidence. For a failure, compare the expected and observed behavior, make a fix, then run the checks again.')}</li>
      </ol>
      <p>{text('프로젝트에는 다음 검사 파일이 필요합니다.', 'A project needs these check files.')} <code>checkmate/프로젝트.json</code>, <code>요구사항.json</code>, <code>검사항목.json</code>.{' '}
        {text('개발 저장소의 예제로 연습할 수 있습니다.', 'You can practice with the example in the development repository.')} <code>examples/대표검증</code>.</p>
    </div>
    <div className="subsection"><h3>{text('실행 결과 읽기', 'Understand a run result')}</h3>
      <dl className="detail-grid"><div><dt>{text('통과', 'Passed')}</dt><dd>{text('선택한 필수 검사가 통과하고 종료와 근거가 확인됐습니다.',
        'Required checks passed, and the run exit and evidence were verified.')}</dd></div>
        <div><dt>{text('실패', 'Failed')}</dt><dd>{text('기대한 동작과 다른 결과가 나왔습니다. 실패 항목의 증거를 확인하세요.',
          'Observed behavior differed from what was expected. Review the failed check and its evidence.')}</dd></div>
        <div><dt>{text('미완료', 'Incomplete')}</dt><dd>{text('필수 검사가 빠졌거나 실행이 끝나지 않았습니다. 빠진 검사를 확인하세요.',
          'A required check is missing or the run did not finish. Review the missing checks.')}</dd></div>
        <div><dt>{text('확인이 필요한 항목', 'Needs review')}</dt><dd>{text('종료, 실행 환경 또는 증거를 확인하지 못했습니다. 무엇을 확인해야 하는지 항목별로 살펴보세요.',
          'The exit, environment, or evidence could not be verified. Review each item to see what needs checking.')}</dd></div></dl>
      <p>{text('이번 검사 묶음 밖의 요구사항은 완료로 취급하지 않습니다. 증거 파일이 바뀌면 과거 통과 결과도 현재 근거로 재사용하지 않습니다.',
        'Requirements outside this check set are not complete. If an evidence file changes, a past pass cannot serve as current evidence.')}</p>
    </div>
    <div className="subsection"><h3>{text('용어와 다음 행동', 'Terms and next steps')}</h3>
      <p>{text('근거는 검사 결과를 뒷받침하는 기록이나 파일입니다. 기대는 검사가 예상한 동작이고 관측은 실제 기록된 동작입니다.',
        'Evidence is a record or file supporting a result. Expected means what the check should see; observed means what it actually recorded.')}</p>
      <p>{text('정리 확인은 실행이 만든 프로세스와 임시 자료가 종료되거나 제거됐는지 사람이 확인해 기록하는 단계입니다.',
        'Cleanup confirmation means a person checks and records whether the run\'s processes and temporary resources have ended or been removed.')}</p>
      <details><summary>{text('실행이 중단되거나 정리가 확인되지 않을 때', 'If a run stops or cleanup is unconfirmed')}</summary>
        <p>{text('실행 결과를 열어 해당 실행의 프로세스와 임시 자료를 직접 확인한 뒤 정리 확인에 내용을 남깁니다. 과거 판정은 그대로 보존됩니다.',
          'Open the run result, check that run\'s processes and temporary resources, then record cleanup confirmation. The earlier outcome stays in the history.')}</p></details>
      <details><summary>{text('AI와 함께 검사할 때', 'When checking with AI')}</summary>
        <p>{text('설정의 MCP 실행 정보를 AI 클라이언트에 추가할 수 있습니다. MCP는 AI가 체크메이트의 검사 기능을 호출하는 연결 방식입니다. 체크메이트는 모델 API 키를 받지 않습니다.',
          'You can add the MCP connection shown in Settings to an AI client. MCP lets the AI call CheckMate checks. CheckMate does not ask for a model API key.')}</p>
        <p>{text('소스나 검사 기준이 바뀌면 새 계획을 확인하고 다시 승인하세요. 실패를 고칠 때 검사나 기대값을 약화하지 마세요.',
          'If source code or check criteria change, review and approve a new plan. Do not weaken checks or expected values to make a failure pass.')}</p></details>
      <details><summary>{text('자료 백업과 개발판 업데이트', 'Backups and development updates')}</summary>
        <p>{text('설정에서 현재 자료를 백업할 수 있습니다. 복구는 새 빈 폴더에만 진행합니다. 현재 개발판은 서명되지 않았고 자동 업데이트를 제공하지 않습니다.',
          'Back up current data in Settings. Restore only to a new empty folder. This development build is unsigned and has no automatic updates.')}</p></details>
    </div>
  </section>;
}
