// 처음 등록부터 AI 연결과 판정 해석까지 오프라인 사용 안내를 제공한다.
export function Help() {
  return <section className="panel" aria-labelledby="help-heading">
    <div className="panel-heading"><div><h2 id="help-heading">체크메이트 시작하기</h2>
      <p>사람과 AI가 같은 검사 결과와 근거를 확인합니다.</p></div></div>
    <div className="subsection"><h3>첫 검사까지</h3>
      <ol>
        <li>로컬 저장소를 준비합니다. 체크메이트의 검사 이력을 이 컴퓨터에 저장합니다.</li>
        <li>프로젝트에서 추가를 누르고 검사 원본이 있는 폴더를 선택합니다.</li>
        <li>검사 프로필을 고르고 계획 확인을 누릅니다.</li>
        <li>실행 명령과 쓰기 범위를 읽고 승인한 다음 검사 실행을 누릅니다.</li>
        <li>최종 판정과 요구사항 근거를 확인합니다. 실패한 항목은 기대와 관측, 증거를 비교합니다.</li>
      </ol>
      <p>프로젝트에는 <code>checkmate/프로젝트.json</code>, <code>요구사항.json</code>, <code>검사항목.json</code>이 필요합니다.
        개발 저장소의 <code>examples/대표검증</code>으로 연습할 수 있습니다.</p>
    </div>
    <div className="subsection"><h3>결과는 이렇게 읽습니다</h3>
      <dl className="detail-grid"><div><dt>통과</dt><dd>선택한 필수 검사가 통과하고 종료와 근거가 확인됐습니다.</dd></div>
        <div><dt>실패</dt><dd>검사에서 기대와 다른 동작이 관측됐습니다.</dd></div>
        <div><dt>미완료</dt><dd>필수 검사가 빠졌거나 실행을 마치지 못했습니다.</dd></div>
        <div><dt>미확인</dt><dd>종료, 환경 또는 증거를 확인하지 못했습니다. 과거 보고서만 가져온 경우도 여기에 해당합니다.</dd></div></dl>
      <p>이번 프로필 밖의 요구사항은 완료가 아닙니다. 증거 파일이 바뀌면 과거 통과 결과도 현재 근거로 재사용하지 않습니다.</p>
    </div>
    <div className="subsection"><h3>AI와 함께 검사하기</h3>
      <p>설정의 MCP 실행 정보를 사용하는 AI 클라이언트에 추가합니다. 체크메이트는 모델 API를 호출하거나 API 키를 받지 않습니다.</p>
      <p>AI에게 다음과 같이 요청할 수 있습니다.</p>
      <blockquote>체크메이트로 승인된 검사를 실행하고 최종 결과를 확인해. 실패하면 수정 자료 묶음과 필요한 증거를 읽고 고쳐.
        검사와 기대값을 약화하지 말고, 수정 후 다시 검사해.</blockquote>
      <p>소스나 검사 기준이 바뀌면 새 계획을 확인해야 합니다. 미검증 화면에서 빠진 검사와 근거를 추적할 수 있습니다.</p>
    </div>
    <div className="subsection"><h3>자주 필요한 확인</h3>
      <details><summary>서비스가 중단되거나 정리가 미확인일 때</summary>
        <p>실행이력에서 해당 결과를 엽니다. 실행이 만든 프로세스와 임시 자료를 직접 확인한 뒤 정리 확인에 내용을 남깁니다.
          새 실행은 허용되지만 과거 미확인 결과는 그대로 보존됩니다.</p></details>
      <details><summary>검사 자료를 보관하거나 옮길 때</summary>
        <p>설정에서 현재 자료 백업을 사용합니다. 복구는 새 빈 폴더에만 진행하며 현재 자료를 덮어쓰지 않습니다.
          확정된 결과는 실행이력에서 HTML 보고서로 저장할 수 있습니다.</p></details>
      <details><summary>개발판 설치와 업데이트</summary>
        <p>현재는 서명 없는 개발판입니다. 검사 이력은 설치 폴더와 별도 자료 폴더에 보관합니다.
          공개 서명된 릴리스와 자동 업데이트는 아직 제공하지 않습니다. 업데이트 전에 진행 중인 검사를 마치고 자료를 백업합니다.</p></details>
    </div>
  </section>;
}
