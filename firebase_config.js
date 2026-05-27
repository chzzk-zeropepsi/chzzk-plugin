// Firebase 설정 — 본인 프로젝트 값으로 채워주세요.
// 1) https://console.firebase.google.com 에서 새 프로젝트 생성
// 2) Realtime Database 활성화 (테스트 모드 또는 아래 보안 규칙 적용)
// 3) Authentication → 로그인 방법 → 익명 사용 설정
// 4) 프로젝트 설정 → 웹 앱 등록 → 아래 값 복사
//
// 권장 RTDB 보안 규칙 (auth.uid 본인 데이터만 R/W):
// {
//   "rules": {
//     "users": {
//       "$uid": {
//         ".read": "auth != null",
//         ".write": "auth != null"
//       }
//     }
//   }
// }
// (chzzk userIdHash를 키로 쓰지만 익명 auth의 UID와 다름. 본인만 본인 chzzk uid 알기에
//  실질적 보호는 약함. 더 엄격하게 하려면 별도 매핑 테이블 필요.)

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCyAKJIz0Wb9xO1A7zI0ouzpHZHwvanqig',
  projectId: 'chzzk-tier-badge',
};
