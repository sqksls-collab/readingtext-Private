# 인강 기능 적용 상태 (2026-11-17)

## 완료
- Supabase `classroom-claude` (`oijqmkpguethqbegkgci`)에 **별도로** `online_courses`, `online_course_lessons`, `online_course_requests`, `online_enrollments`, `online_lesson_progress`, `online_lesson_media` 등 6개 테이블 생성.
- 새 테이블 모두 RLS 적용, 학생은 본인 수강권만 접근하고 강사가 신청을 승인하도록 정책 설정.
- `approve_online_course_request(uuid)` 및 관련 권한 검사 함수 생성.
- 이 브랜치에 기존 LMS를 유지하는 인강 카탈로그·신청·강의실·관리 화면 반영.

## 주의
- `main`에 병합하거나 직접 배포하지 않음. 기존 운영 사이트는 계속 기존 화면으로 동작함.
- 이미 DB에 인강 스키마를 생성했으므로 별도 ZIP의 `supabase/online_courses.sql`을 다시 실행하지 말 것. 개발본 SQL과 실제 적용된 DB 구조는 별도로 일치 검증해야 함.
- 카드 결제는 미연결. 현재 수강 신청 및 강사의 수동 승인을 위한 UI만 구현됨. 입금 확인은 자동으로 이루어지지 않음.
- YouTube 영상 ID에 기반한 재생으로, 유료 인강의 DRM·복제/공유 방지가 보장되지 않음.
- 실제 학생·관리자 로그인, 승인, RLS 접근, 수강 만료, 동영상 재생에 대한 통합 테스트가 필요함.
- Netlify 미리보기 또는 운영 배포를 실행하기 전에 사용자 승인 및 비용/크레딧 확인이 필요함.
- GitHub 저장소가 Public으로 확인되었으므로 공개 코드의 키/설정 및 접근 권한을 검토할 것.
