/* =========================================================
   미션 내역 (mission_list.js) — 시작전 · 진행중 · 종료 통합 (v2)
   ※ v1(미션 완료 내역, mission_complete.js)은 기록용으로 보존
   - 도메인: 고릴라(컨트롤룸)에 등록된 「기간 미션」을 그라이더 / 그라이더플러스 라이더가 수행
     · 주문·미션은 고릴라에서 가져오고, 참여/인정 카운팅은 레오엑스가 수행
     · 지원금은 단계별(최대 5단계) 중 라이더가 도달한 최상위 1개만 지급
   - 의존: jQuery 3.x, jQuery UI(datepicker), select2, sweetalert2 (어드민 공통 로드)
   - CONFIG.USE_MOCK = true 이면 화면 내 목데이터로 동작.
     서버 연동 시 false 로 바꾸고 API 객체의 URL 만 맞추면 됨.
   ========================================================= */
(function ($, window) {
  'use strict';

  /* ---------------------------------------------------------
     설정
  --------------------------------------------------------- */
  var CONFIG = {
    USE_MOCK: true,
    API_BASE: '/admin/mission-completions',
    PAGE_SIZE: 20,
    MAX_RANGE_DAYS: 92,
    EXPORT_CLIENT: true,          // true: 브라우저에서 xlsx 생성(SheetJS) / false: 서버 export URL
    EXPORT_MAX_ORDERS: 30000      // 주문 단위 시트 상한
  };

  /* 미인정 사유 코드 → 라벨 */
  var REJECT = {
    OUT_OF_PERIOD:       '운영시간 외 접수',
    PARTNER_MISMATCH:    '주문 제휴사 불일치',
    REGION_MISMATCH:     '적용 지역 외',
    AGENCY_MISMATCH:     '배달대행사 불일치',
    TIME_LIMIT_EXCEEDED: '수행시간 초과',
    ORDER_CANCELLED:     '주문 취소',
    DUPLICATE:           '중복',
    UNKNOWN:             '사유 불명'
  };

  var TYPE_LABEL = { RECEIPT: '접수 후', DISPATCH: '배차 후' };
  /* 미션 타입(진행 방식): 기간한정 / 반복(일일·주간·월간·요일) */
  var KIND_LABEL = { PERIOD: '기간한정', DAILY: '반복(일일)', WEEKLY: '반복(주간)', MONTHLY: '반복(월간)', WEEKDAY: '반복(요일)' };
  var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

  /* 미션 상태: 시작전 / 진행중 / 종료 (적용 기간 vs 현재 시각) */
  var STATUS_LABEL = {
    RUNNING: { text: '진행중', cls: 'mc-status--running', rank: 0 },
    BEFORE:  { text: '시작전', cls: 'mc-status--before',  rank: 1 },
    ENDED:   { text: '완료',   cls: 'mc-status--ended',   rank: 2 }
  };

  /* 지급 정책: 최고 단계 달성 = 즉시 지급, 그 외 = 익일 00:30 일괄 지급 */
  var PAY_RULE = { NEXT_DAY_HOUR: 0, NEXT_DAY_MIN: 30 };

  var PAY_LABEL = {
    PAID:      { text: '지급완료', cls: 'mc-badge--green' },
    PENDING:   { text: '지급예정', cls: 'mc-badge--blue' },
    CANCELLED: { text: '지급취소', cls: 'mc-badge--red' },
    CLOSED:    { text: '선착순 마감', cls: 'mc-badge--gray' }
  };

  var CANCEL_REASONS = ['중복 계정으로 확인됨', '부정 배차(허위 완료) 적발', '제휴사 요청으로 취소', '라이더 본인 요청'];

  /* ---------------------------------------------------------
     상태
  --------------------------------------------------------- */
  var state = {
    tab: 'mission',                 // mission | participant
    page: 1,
    size: CONFIG.PAGE_SIZE,
    sort: { mission: { field: 'statusRank', dir: 'asc' },
            participant: { field: 'performed', dir: 'desc' },
            order: { field: 'receivedAt', dir: 'desc' } },
    filters: {},
    mission: null,                  // 미션별 → 참여자 보기 로 진입한 경우 { id, title }
    openRows: {},                   // participant 행 펼침 상태
    counts: { mission: 0, participant: 0, order: 0 }
  };

  var $root, $kpis, $tbody, $thead, $foot, $pager, $tabs;

  /* ---------------------------------------------------------
     유틸
  --------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function comma(n) {
    if (n == null || isNaN(n)) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(a, b) {
    if (!b) return null;
    return Math.round((a / b) * 1000) / 10;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtDateTime(d) { d = new Date(d); return fmtDate(d) + ' ' + fmtTime(d); }
  /* 미션 종료 기준 익일 00:30 */
  function nextDayPayTime(periodEnd) {
    var d = new Date(periodEnd);
    d.setDate(d.getDate() + 1);
    d.setHours(PAY_RULE.NEXT_DAY_HOUR, PAY_RULE.NEXT_DAY_MIN, 0, 0);
    return d;
  }
  function fmtPeriod(s, e) {
    var sd = new Date(s), ed = new Date(e);
    var same = sd.toDateString() === ed.toDateString();
    var a = pad(sd.getMonth() + 1) + '/' + pad(sd.getDate()) + ' ' + fmtTime(sd);
    var b = same ? fmtTime(ed) : pad(ed.getMonth() + 1) + '/' + pad(ed.getDate()) + ' ' + fmtTime(ed);
    return a + '–' + b;
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function listLabel(names) {
    // ['요기배달','올리브영','CU'] → '요기배달 · 올리브영 외 1개' (고릴라 표기 방식)
    if (!names || !names.length) return '전체';
    if (names.length <= 2) return names.join(' · ');
    return names.slice(0, 2).join(' · ') + ' 외 ' + (names.length - 2) + '개';
  }
  function tiersLabel(tiers) {
    return tiers.map(function (t) { return t.count + '건: ' + comma(t.reward) + '원'; }).join(' / ');
  }

  function barHtml(value, thresholds) {
    // thresholds: { low: 30, bad: 10 }  → value 미만이면 색 변경
    if (value == null) return '<span class="muted">—</span>';
    var cls = '';
    if (value < thresholds.bad) cls = 'is-bad';
    else if (value < thresholds.low) cls = 'is-low';
    return '<span class="mc-bar">' +
      '<span class="mc-bar__track"><span class="mc-bar__fill ' + cls + '" style="width:' + Math.min(100, value) + '%"></span></span>' +
      '<span class="mc-bar__val ' + (cls === 'is-bad' ? 'is-bad' : '') + '">' + value.toFixed(1) + '%</span>' +
      '</span>';
  }

  function toast(icon, title) {
    if (!window.Swal) return;
    Swal.fire({ toast: true, position: 'top-end', icon: icon, title: title, showConfirmButton: false, timer: 1800 });
  }

  /* ---------------------------------------------------------
     MOCK 데이터  (고릴라 기간미션 구조를 그대로 흉내)
     - 시드 기반 난수 → 새로고침해도 동일한 화면
  --------------------------------------------------------- */
  var MOCK = (function () {
    var seed = 20260909;
    var NOW = new Date();
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

    var partners = [                       // 주문 제휴사
      { id: 1, name: '요기배달' },
      { id: 2, name: '올리브영' },
      { id: 3, name: 'CU' },
      { id: 4, name: '다이소' },
      { id: 5, name: '땡배달' }
    ];
    var agencies = [                       // 배달대행사
      { id: 'GR',  name: '그라이더' },
      { id: 'GRP', name: '그라이더플러스' }
    ];
    var regions = [                        // 적용 지역 (고릴라 표기) — list: 전체 지역 목록 (툴팁용)
      { id: 21, name: '서울 강남구', extra: 12, list: ['서울 강남구','서울 강동구','서울 송파구','서울 서초구','서울 관악구','서울 동작구','서울 영등포구','서울 마포구','서울 용산구','서울 성동구','서울 광진구','서울 중구','서울 종로구'] },
      { id: 22, name: '충남 천안시 서북구', extra: 0, list: ['충남 천안시 서북구'] },
      { id: 23, name: '대전 동구', extra: 1, list: ['대전 동구','대전 유성구'] },
      { id: 24, name: '경남 김해시', extra: 0, list: ['경남 김해시'] },
      { id: 25, name: '광주 광산구', extra: 0, list: ['광주 광산구'] },
      { id: 26, name: '인천 남동구', extra: 1, list: ['인천 남동구','인천 미추홀구'] },
      { id: 27, name: '경기 광명시', extra: 3, list: ['경기 광명시','경기 성남시 분당구','경기 성남시 수정구','경기 하남시'] }
    ];
    var names = ['박상현','김도윤','이서준','최민재','정하늘','한지우','오세훈','윤서아','장예린','임태양','강하람','조은우','배수빈','신유진','문준서','권다인','홍시우','서지호','노아윤','류채원'];
    var tiers3 = [{ count: 4, reward: 2400 }, { count: 7, reward: 7000 }, { count: 12, reward: 14000 }];

    var CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var missions = [];
    var participants = [];
    var missionSeq = 100, partSeq = 5000;

    /* 라이더 풀: 대행사별 70명. 같은 라이더가 여러 미션에 참여하도록 미션마다 이 풀에서 뽑는다 */
    var RIDERS = [];
    (function () {
      ['GR', 'GRP'].forEach(function (ag) {
        for (var i = 0; i < 70; i++) {
          var nm = names[i % names.length] + (i >= names.length ? String(Math.floor(i / names.length) + 1) : '');
          RIDERS.push({ riderId: riderCode(), riderName: nm, agencyId: ag, hubRegionId: pick(regions).id });
        }
      });
    })();
    function pickRider(agencyIds, usedIds) {
      var pool = RIDERS.filter(function (r) { return agencyIds.indexOf(r.agencyId) >= 0 && !usedIds[r.riderId]; });
      return pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
    }

    /* 라이더 코드: 어드민 실제 형식 (예: PKQU8LHP30I4UGQUU — 대문자+숫자 17자) */
    function riderCode() {
      var c = 'PKQU8LHP30I4UG';
      for (var i = 0; i < 3; i++) c += CODE_CHARS[Math.floor(rnd() * CODE_CHARS.length)];
      return c;
    }

    function makeMission(o) {
      var m = $.extend({
        id: ++missionSeq,
        type: 'RECEIPT',                 // RECEIPT 접수 후 | DISPATCH 배차 후
        limitMin: 90,
        partnerIds: [1, 2],
        agencyIds: ['GR', 'GRP'],
        regionId: null,
        tiers: tiers3,
        creator: '한**',
        // ---- 미션 상세(설정) 필드 — 고릴라/레오엑스 미션 설정 화면과 동일 항목 ----
        description: '',
        missionKind: 'PERIOD',            // REPEAT 반복 | PERIOD 기간한정
        dailyReset: false,                // 이벤트 진행: 매일 초기화 / 초기화 없음
        baseTime: 'ASSIGNED',             // 기준 시간: ASSIGNED 배정한 시간 | COMPLETED 완료한 시간
        progressTime: ['00:00:00', '00:00:00'],
        sharedCall: 'ALL',                // ALL 자사+공유포함 | OWN 자사만 | SHARED 공유만
        countingCond: { distance: false, zone: false },
        firstCome: false,                 // 선착순 지급
        completeCond: { commute: false, receiptTime: true, firstCall: false },
        rewardType: 'CASH'
      }, o);
      if (!m.limitMin) m.completeCond = $.extend({}, m.completeCond, { receiptTime: false });
      if (m.type === 'DISPATCH') m.baseTime = 'ASSIGNED'; else m.baseTime = 'COMPLETED';
      missions.push(m);
      // 참여자 생성
      var n = o.noParticipants ? 0 : ri(o.minP || 6, o.maxP || 34);
      var used = {};
      for (var i = 0; i < n; i++) {
        var rider = pickRider(m.agencyIds, used); if (!rider) break; used[rider.riderId] = 1;
        var performed = ri(1, 15);
        if (missionStatus(m) === 'RUNNING') performed = Math.max(1, Math.round(performed * 0.45));   // 진행 중 → 아직 절반 수준
        var bias = m.rejectBias == null ? 0.06 : m.rejectBias;
        var rejected = 0;
        for (var k = 0; k < performed; k++) if (rnd() < bias) rejected++;
        var accepted = performed - rejected;
        var tier = null;                  // 도달한 최상위 단계 1개만
        for (var t = m.tiers.length - 1; t >= 0; t--) if (accepted >= m.tiers[t].count) { tier = m.tiers[t]; break; }
        // 지급 시각: 최고 단계 = 달성 즉시, 그 외 = 익일 00:30. 아직 안 왔으면 지급예정
        var ps = new Date(m.periodStart), pe = new Date(m.periodEnd);
        var achievedAt = tier ? new Date(ps.getTime() + Math.floor((pe - ps) * (0.55 + rnd() * 0.45))) : null;
        var isTop = tier && tier.count === m.tiers[m.tiers.length - 1].count;
        var payDue = tier ? (isTop ? achievedAt : nextDayPayTime(m.periodEnd)) : null;
        var status = 'NONE';
        if (tier) {
          if (payDue > NOW) status = 'PENDING';
          else status = rnd() < 0.07 ? 'CANCELLED' : 'PAID';   // 데모용 취소 비율
        }
        var cancelled = status === 'CANCELLED';
        participants.push({
          id: ++partSeq,
          missionId: m.id,
          riderId: rider.riderId,
          riderName: rider.riderName,
          agencyId: rider.agencyId,
          hubRegionId: rider.hubRegionId,
          hubName: null,   // 아래에서 agencyId · 라이더 소속 지역으로 채움
          performed: performed,
          accepted: accepted,
          rejected: rejected,
          tierCount: tier ? tier.count : null,
          reward: tier ? tier.reward : 0,
          status: status,
          isTopTier: !!isTop,
          achievedAt: achievedAt,
          payDueAt: payDue,                                        // 지급(예정) 시각
          paidAt: (status === 'PAID' || cancelled) ? payDue : null,
          cancelledAt: cancelled ? new Date(payDue.getTime() + (30 + ri(0, 600)) * 60000) : null,
          cancelledBy: cancelled ? '관리자A' : null,
          cancelReason: cancelled ? CANCEL_REASONS[ri(0, CANCEL_REASONS.length - 1)] : null,
          hasUnknown: rejected > 0 && rnd() < 0.15
        });
      }
    }

    // 09/01 ~ 09/08 — 제휴사별 기간미션 × 지역  (고릴라 화면의 지역별 카드 구조)
    for (var d = 1; d <= 8; d++) {
      var day = '2026-09-0' + d;
      var created = '2026-09-0' + (d - 1 || 1) + ' 21:0' + ri(0, 4) + ':' + pad(ri(0, 59));

      // 올리브영 (요기배달 채널) — 오전/오후, 그라이더·그라이더플러스 전체
      [{ t: '오전', s: '11:00', e: '16:00' }, { t: '오후', s: '17:00', e: '22:00' }].forEach(function (slot) {
        regions.slice(0, d % 2 === 0 ? 3 : 2).forEach(function (r) {
          var low = (d === 4 && slot.t === '오후' && r.id === 23);   // 카운팅 누락 시나리오 (대전 동구)
          makeMission({
            title: '[' + slot.t + '] 올영세일 12건 달성 보너스',
            partnerIds: [1, 2], regionId: r.id, agencyIds: ['GR', 'GRP'],
            periodStart: day + 'T' + slot.s + ':00', periodEnd: day + 'T' + slot.e + ':00',
            type: d >= 5 ? 'DISPATCH' : 'RECEIPT', limitMin: d >= 5 ? 60 : 90,
            rejectBias: low ? 0.6 : (d === 7 ? 0.14 : 0.05),
            minP: low ? 14 : 8, maxP: low ? 20 : 34,
            createdAt: created
          });
        });
      });

      // 땡배달 — 점심 피크, 그라이더 단독 / 그라이더플러스 단독 번갈아
      [regions[0], regions[5], regions[6]].forEach(function (r, i) {
        makeMission({
          title: '[점심] 땡배달 5건 달성 보너스',
          missionKind: 'REPEAT', repeatBasis: 'DAILY', firstCome: 20,
          partnerIds: [5], regionId: r.id, agencyIds: (d + i) % 2 === 0 ? ['GR'] : ['GRP'],
          periodStart: day + 'T11:30:00', periodEnd: day + 'T14:00:00',
          type: 'RECEIPT', limitMin: 40,
          tiers: [{ count: 3, reward: 1500 }, { count: 5, reward: 4000 }, { count: 8, reward: 8000 }],
          minP: 10, maxP: 30, rejectBias: d === 6 ? 0.2 : 0.05, createdAt: created
        });
      });

      // 요기배달 — 저녁 피크, 전체 대행사
      if (d % 2 === 1) {
        [regions[0], regions[3], regions[4]].forEach(function (r) {
          makeMission({
            title: '[저녁] 요기배달 7건 달성 보너스',
            missionKind: 'REPEAT', repeatBasis: 'WEEKDAY', weekdays: [5, 6, 0],
            partnerIds: [1], regionId: r.id, agencyIds: ['GR', 'GRP'],
            periodStart: day + 'T17:30:00', periodEnd: day + 'T21:00:00',
            type: 'DISPATCH', limitMin: 35,
            tiers: [{ count: 4, reward: 2000 }, { count: 7, reward: 6000 }, { count: 10, reward: 10000 }, { count: 15, reward: 18000 }],
            minP: 12, maxP: 40, rejectBias: 0.07, createdAt: created
          });
        });
      }
    }
    // 오늘 오전 종료 미션 — 최고 단계는 즉시 지급, 나머지는 익일 00:30 → '지급예정' 케이스
    var today = fmtDate(NOW);
    [regions[0], regions[1]].forEach(function (r) {
      makeMission({ title: '[아침] 올영세일 10건 달성 보너스', partnerIds: [1, 2], regionId: r.id, agencyIds: ['GR', 'GRP'],
        periodStart: today + 'T07:00:00', periodEnd: today + 'T11:00:00', type: 'RECEIPT', limitMin: 60,
        tiers: [{ count: 4, reward: 2000 }, { count: 7, reward: 5000 }, { count: 10, reward: 10000 }],
        minP: 12, maxP: 24, rejectBias: 0.05, createdAt: today + ' 06:30:00' });
    });

    // ---- 진행중 미션: 현재 시각을 포함하는 기간 ----
    function iso(d) { return fmtDate(d) + 'T' + fmtTime(d) + ':00'; }
    var rs = new Date(NOW.getTime() - 90 * 60000), re = new Date(NOW.getTime() + 150 * 60000);
    [regions[0], regions[2]].forEach(function (r) {
      makeMission({ title: '[오후] 올영세일 12건 달성 보너스', partnerIds: [1, 2], regionId: r.id, agencyIds: ['GR', 'GRP'],
        periodStart: iso(rs), periodEnd: iso(re), type: 'DISPATCH', limitMin: 60,
        minP: 8, maxP: 20, rejectBias: 0.05, createdAt: today + ' 06:40:00' });
    });
    makeMission({ title: '[점심] 땡배달 5건 달성 보너스', missionKind: 'REPEAT', repeatBasis: 'DAILY', firstCome: 20, countingCond: { distance: 100, zone: false }, partnerIds: [5], regionId: 26, agencyIds: ['GRP'],
      periodStart: iso(new Date(NOW.getTime() - 40 * 60000)), periodEnd: iso(new Date(NOW.getTime() + 100 * 60000)), type: 'RECEIPT', limitMin: 40,
      tiers: [{ count: 3, reward: 1500 }, { count: 5, reward: 4000 }, { count: 8, reward: 8000 }],
      minP: 6, maxP: 14, rejectBias: 0.06, createdAt: today + ' 06:40:00' });

    // ---- 시작전 미션: 오늘 저녁 / 내일 ----
    var us = new Date(NOW.getTime() + 3 * 3600000), ue = new Date(NOW.getTime() + 7 * 3600000);
    [regions[0], regions[3]].forEach(function (r) {
      makeMission({ title: '[저녁] 요기배달 7건 달성 보너스', missionKind: 'REPEAT', repeatBasis: 'WEEKDAY', weekdays: [5, 6, 0], partnerIds: [1], regionId: r.id, agencyIds: ['GR', 'GRP'],
        periodStart: iso(us), periodEnd: iso(ue), type: 'DISPATCH', limitMin: 35,
        tiers: [{ count: 4, reward: 2000 }, { count: 7, reward: 6000 }, { count: 10, reward: 10000 }, { count: 15, reward: 18000 }],
        noParticipants: true, createdAt: today + ' 09:10:00' });
    });
    var tmr = fmtDate(addDays(NOW, 1));
    [regions[0], regions[1], regions[2]].forEach(function (r) {
      makeMission({ title: '[오전] 올영세일 12건 달성 보너스', partnerIds: [1, 2], regionId: r.id, agencyIds: ['GR', 'GRP'],
        periodStart: tmr + 'T11:00:00', periodEnd: tmr + 'T16:00:00', type: 'DISPATCH', limitMin: 60,
        noParticipants: true, createdAt: today + ' 09:12:00' });
    });

    // 기타 미션
    makeMission({ title: '주말 피크 3건 완료 보너스', missionKind: 'REPEAT', repeatBasis: 'WEEKLY', countingCond: { distance: 1500, zone: false }, completeCond: { commute: 3, receiptTime: true, firstCall: false }, partnerIds: [1], regionId: 21, agencyIds: ['GR'],
      periodStart: '2026-09-06T11:00:00', periodEnd: '2026-09-06T14:00:00', type: 'RECEIPT', limitMin: 120,
      tiers: [{ count: 3, reward: 3000 }, { count: 6, reward: 7000 }], minP: 40, maxP: 60, rejectBias: 0.03, createdAt: '2026-09-05 18:12:40' });
    makeMission({ title: 'CU 야간 5건 달성 보너스', missionKind: 'REPEAT', repeatBasis: 'MONTHLY', firstCome: 10, countingCond: { distance: false, zone: true }, partnerIds: [3], regionId: 26, agencyIds: ['GRP'],
      periodStart: '2026-09-07T21:00:00', periodEnd: '2026-09-08T01:00:00', type: 'DISPATCH', limitMin: 45,
      tiers: [{ count: 5, reward: 5000 }], minP: 10, maxP: 25, rejectBias: 0.04, createdAt: '2026-09-07 10:02:11' });
    makeMission({ title: '다이소 첫 배송 미션', completeCond: { commute: false, receiptTime: false, firstCall: true }, partnerIds: [4], regionId: 22, agencyIds: ['GR', 'GRP'],
      periodStart: '2026-09-03T00:00:00', periodEnd: '2026-09-03T23:59:00', type: 'RECEIPT', limitMin: 0,
      tiers: [{ count: 20, reward: 10000 }], minP: 5, maxP: 8, rejectBias: 0, createdAt: '2026-09-02 09:30:00' });

    /* 소속 허브: 그라이더플러스 → 'GP' + 지역(공백·시/구/군 제거, 예: GP서울강남), 그라이더 → '그라이더' */
    function hubOf(agencyId, regionId) {
      if (agencyId !== 'GRP') return '그라이더';
      var r = regionById(regionId);
      var core = String(r.name).split(' ').map(function (t) { return t.replace(/(특별시|광역시|시|구|군)$/, ''); }).join('');
      return 'GP' + core;
    }
    /* 수행허브코드: 실제 형식 HB108LHP30I4UG001 — 앞 14자리 고정, 뒷 3자리가 허브별 일련 */
    var HUB_CODES = {};
    function hubCodeOf(hubName) {
      if (!HUB_CODES[hubName]) HUB_CODES[hubName] = 'HB108LHP30I4UG' + ('00' + (Object.keys(HUB_CODES).length + 1)).slice(-3);
      return HUB_CODES[hubName];
    }
    participants.forEach(function (p) { p.hubName = hubOf(p.agencyId, p.hubRegionId); p.hubCode = hubCodeOf(p.hubName); });

    /* 선착순: 달성 시각 순 N명까지만 지급, 이후 달성자는 '선착순 마감' */
    missions.forEach(function (m) {
      if (!m.firstCome) return;
      var achievers = participants.filter(function (p) { return p.missionId === m.id && p.tierCount; })
        .sort(function (a, b) { return a.achievedAt - b.achievedAt; });
      achievers.slice(m.firstCome).forEach(function (p) { p.status = 'CLOSED'; p.paidAt = null; p.payDueAt = null; p.cancelledAt = null; p.cancelReason = null; });
    });

    /* 상태: 적용 기간 vs 현재 */
    function missionStatus(m) {
      var s = new Date(m.periodStart), e = new Date(m.periodEnd);
      return NOW < s ? 'BEFORE' : (NOW < e ? 'RUNNING' : 'ENDED');
    }

    /* 화주사별 주문아이디 형식 (실데이터 예: 요기배달 341978828243162973 / 땡배달 D26I09DVZRX|1 / 스타벅스 320260909140141...) */
    function orderExtId(partner, lr) {
      function digits(n) { var o = ''; for (var i = 0; i < n; i++) o += Math.floor(lr() * 10); return o; }
      if (partner === '요기배달') return '3419788' + digits(11);
      if (partner === '땡배달') { var o = 'D26I09'; for (var i = 0; i < 5; i++) o += CODE_CHARS[Math.floor(lr() * CODE_CHARS.length)]; return o + '|1'; }
      return '3202609' + digits(13);
    }

    /* 상점명 목데이터: 플랫폼(요기배달·땡배달)은 입점 음식점, 그 외 화주사는 '브랜드 + 지역 + 점' */
    var SHOPS = ['교촌치킨', 'BBQ', '맘스터치', '한솥도시락', '김밥천국', '메가커피', '이삭토스트', '봉구스밥버거', '피자스쿨', '역전우동', '홍콩반점', '샐러디', '써브웨이', '노랑통닭', '두찜'];
    function storeName(partner, region, lr) {
      var area = String(region).replace(/^(서울|경기|인천|충남|대전|광주|경남)\s*/, '').split(' ')[0].replace(/(시|구)$/, '');
      if (partner === '요기배달' || partner === '땡배달') return SHOPS[Math.floor(lr() * SHOPS.length)] + ' ' + area + '점';
      return partner + ' ' + area + (lr() < 0.5 ? '역점' : '점');
    }

    /* 주문 단위 목데이터 — 참여자 기준으로 생성 */
    function ordersFor(p) {
      var m = missionById(p.missionId);
      var s = new Date(m.periodStart), e = new Date(m.periodEnd);
      var span = (e - s) / 60000;
      var list = [];
      var localSeed = p.id * 7919;
      function lr() { localSeed = (localSeed * 1103515245 + 12345) & 0x7fffffff; return localSeed / 0x7fffffff; }
      var reasons = ['TIME_LIMIT_EXCEEDED','PARTNER_MISMATCH','REGION_MISMATCH','ORDER_CANCELLED','DUPLICATE'];   // 운영시간 외 접수는 실제 발생하지 않아 제외
      var partnerNames = m.partnerIds.map(function (id) { return partnerById(id).name; });
      var regionName = regionById(m.regionId).name;
      for (var i = 0; i < p.performed; i++) {
        var accepted = i < p.accepted;
        var offset = Math.floor(lr() * span);
        var at = new Date(s.getTime() + offset * 60000);           // 접수
        var dispatchGap = 3 + Math.floor(lr() * 8);                  // 접수→배차
        var limitBase = m.type === 'DISPATCH' ? dispatchGap : 0;
        var dur = limitBase + 15 + Math.floor(lr() * (accepted ? Math.max(15, (m.limitMin || 120) - 25) : 120));
        var reason = null, note = '', pName = partnerNames[Math.floor(lr() * partnerNames.length)], rName = regionName;
        if (!accepted) {
          reason = (p.hasUnknown && i === p.performed - 1) ? 'UNKNOWN' : reasons[Math.floor(lr() * reasons.length)];
          if (reason === 'TIME_LIMIT_EXCEEDED') { dur = limitBase + (m.limitMin || 90) + 5 + Math.floor(lr() * 40); note = TYPE_LABEL[m.type] + ' ' + m.limitMin + '분 조건'; }
          if (reason === 'PARTNER_MISMATCH') { pName = lr() < 0.5 ? '버거킹' : '맥도날드'; }   // 미션 대상 외 제휴사 예시
          if (reason === 'REGION_MISMATCH') { rName = '서울 송파구'; note = '서울 송파구'; }
          if (reason === 'OUT_OF_PERIOD') { at = new Date(e.getTime() + (1 + Math.floor(lr() * 30)) * 60000); note = '종료 ' + fmtTime(e); }
          if (reason === 'ORDER_CANCELLED') { dur = null; }
        }
        var cancelled = reason === 'ORDER_CANCELLED';
        var pickGap = dispatchGap + 3 + Math.floor(lr() * 8);                    // 접수→픽업
        if (dur != null && dur < pickGap + 5) dur = pickGap + 5;                 // 완료는 항상 픽업 이후
        var cancelAfterDispatch = cancelled && lr() < 0.6;                        // 취소: 배차 전/후 섞어서
        list.push({
          orderNo: String(8600000 + (p.id * 37 + i * 3) % 99999),          // 어드민 주문번호 (7자리 일련)
          orderExtId: orderExtId(pName, lr),                                // 화주사 측 주문아이디
          partner: pName,
          storeName: storeName(pName, rName, lr),
          region: rName,
          receivedAt: at,
          dispatchedAt: (!cancelled || cancelAfterDispatch) ? new Date(at.getTime() + dispatchGap * 60000) : null,
          pickedAt: !cancelled ? new Date(at.getTime() + pickGap * 60000) : null,
          completedAt: !cancelled ? new Date(at.getTime() + dur * 60000) : null,
          cancelledAt: cancelled ? new Date(at.getTime() + (cancelAfterDispatch ? dispatchGap + 2 + Math.floor(lr() * 10) : 1 + Math.floor(lr() * 5)) * 60000) : null,
          durationMin: cancelled ? null : (m.type === 'DISPATCH' ? dur - dispatchGap : dur),   // 미션 타입 기준 소요
          accepted: accepted && !cancelled,                                       // 인정은 완료건에 한함
          rejectReason: reason,
          note: note
        });
      }
      list.sort(function (a, b) { return a.receivedAt - b.receivedAt; });
      return list;
    }

    function missionById(id) { for (var i = 0; i < missions.length; i++) if (missions[i].id === id) return missions[i]; }
    function partnerById(id) { for (var i = 0; i < partners.length; i++) if (partners[i].id === id) return partners[i]; return { id: 0, name: '전체' }; }
    function agencyById(id) { for (var i = 0; i < agencies.length; i++) if (agencies[i].id === id) return agencies[i]; return { id: '', name: '-' }; }
    function regionById(id) { for (var i = 0; i < regions.length; i++) if (regions[i].id === id) return regions[i]; return { id: 0, name: '전체 지역', extra: 0 }; }
    function regionLabel(r) { return r.name + (r.extra ? ' 외 ' + r.extra + '개' : ''); }
    function regionTip(r) { return (r.list && r.list.length > 1) ? r.list.join(', ') : ''; }

    /* 미션 집계 */
    function aggregate(m) {
      var ps = participants.filter(function (p) { return p.missionId === m.id; });
      var agg = { participants: ps.length, performed: 0, accepted: 0, completed: 0, paid: 0, cancelled: 0, unknown: 0 };
      agg.firstComeUsed = 0;
      ps.forEach(function (p) {
        agg.performed += p.performed;
        agg.accepted += p.accepted;
        if (p.tierCount && p.status !== 'CANCELLED' && p.status !== 'CLOSED') { agg.completed++; agg.paid += p.reward; agg.firstComeUsed++; }
        if (p.status === 'CANCELLED') agg.cancelled++;
        if (p.hasUnknown) agg.unknown++;
      });
      var st = missionStatus(m);
      var ps = new Date(m.periodStart), pe = new Date(m.periodEnd);
      var kindKey = m.missionKind === 'REPEAT' ? (m.repeatBasis || 'DAILY') : 'PERIOD';
      // 부가 조건 뱃지 (선착순 · 거리 · 권역 · 출퇴근 · 첫 콜)
      var conds = [];
      if (m.firstCome) conds.push({ key: 'firstCome', text: '선착순 ' + m.firstCome + '명', sub: st === 'BEFORE' ? null : (agg.firstComeUsed >= m.firstCome ? '마감' : agg.firstComeUsed + '명 지급'), closed: st !== 'BEFORE' && agg.firstComeUsed >= m.firstCome });
      if (m.completeCond && m.completeCond.commute) conds.push({ key: 'commute', text: '출퇴근 ' + m.completeCond.commute + '회' });
      if (m.completeCond && m.completeCond.firstCall) conds.push({ key: 'firstCall', text: '첫 콜만' });
      return $.extend({}, m, agg, {
        conds: conds,
        condText: conds.map(function (c) { return c.text + (c.sub ? ' (' + c.sub + ')' : ''); }).join(', '),
        kindKey: kindKey,
        kindLabel: KIND_LABEL[kindKey],
        kindSub: (kindKey === 'WEEKDAY' && m.weekdays) ? m.weekdays.map(function (w) { return WEEKDAY_KO[w]; }).join('·') : '',
        status: st,
        statusRank: STATUS_LABEL[st].rank,
        progress: st === 'RUNNING' ? Math.round((NOW - ps) / (pe - ps) * 100) : (st === 'ENDED' ? 100 : 0),
        partnerNames: m.partnerIds.map(function (id) { return partnerById(id).name; }),
        agencyNames: m.agencyIds.map(function (id) { return agencyById(id).name; }),
        // 리스트 표기: 두 대행사 모두면 '전체', 아니면 해당 대행사명
        agencyLabel: m.agencyIds.length >= agencies.length ? '전체' : m.agencyIds.map(function (id) { return agencyById(id).name; }).join(' · '),
        regionName: regionLabel(regionById(m.regionId)),
        regionTip: regionTip(regionById(m.regionId)),
        acceptRate: pct(agg.accepted, agg.performed),
        completeRate: pct(agg.accepted, agg.performed)          // 완료율 = 인정건 ÷ 수행건
      });
    }

    return {
      partners: partners, agencies: agencies, regions: regions, missions: missions, participants: participants,
      missionById: missionById, partnerById: partnerById, agencyById: agencyById, regionById: regionById, regionLabel: regionLabel, regionTip: regionTip, missionStatus: missionStatus,
      aggregate: aggregate, ordersFor: ordersFor
    };
  })();

  /* ---------------------------------------------------------
     API 레이어 — USE_MOCK 에 따라 분기
  --------------------------------------------------------- */
  function delay(data, ms) {
    var d = $.Deferred();
    setTimeout(function () { d.resolve(data); }, ms == null ? 180 : ms);
    return d.promise();
  }

  function matchesMission(m, f) {
    if (f.missionId && m.id !== Number(f.missionId)) return false;
    if (f.status && MOCK.missionStatus(m) !== f.status) return false;
    if (f.kind) { var kk = m.missionKind === 'REPEAT' ? (m.repeatBasis || 'DAILY') : 'PERIOD'; if (kk !== f.kind) return false; }
    if (f.dateBasis !== 'paid') {
      if (f.from && m.periodEnd < f.from + 'T00:00:00') return false;
      if (f.to && m.periodStart > f.to + 'T23:59:59') return false;
    }
    if (f.partnerIds && f.partnerIds.length && !m.partnerIds.some(function (id) { return f.partnerIds.indexOf(id) >= 0; })) return false;
    if (f.agencyId && m.agencyIds.indexOf(f.agencyId) < 0) return false;
    if (f.missionType && m.type !== f.missionType) return false;
    return true;
  }

  /* 검색어 매칭 — 카테고리별
     MISSION    : 미션명
     RIDER_CODE : 라이더 코드
     RIDER_NAME : 라이더 이름
     ALL        : 셋 중 하나라도                                            */
  function kwRegion(m, f) {
    var r = MOCK.regionById(m.regionId);
    return MOCK.regionLabel(r).indexOf(f.keyword) >= 0 || (r.list || []).some(function (n) { return n.indexOf(f.keyword) >= 0; });
  }
  function kwPartner(m, f) {
    return m.partnerIds.some(function (id) { return MOCK.partnerById(id).name.indexOf(f.keyword) >= 0; });
  }
  function kwMission(m, f) {
    if (!f.keyword) return true;
    var t = f.keywordType || 'ALL';
    if (t === 'REGION') return kwRegion(m, f);
    if (t === 'PARTNER') return kwPartner(m, f);
    if (t === 'ORDER_NO' || t === 'ORDER_EXT') return true;
    if (t === 'MISSION' || t === 'ALL') {
      if (m.title.indexOf(f.keyword) >= 0) return true;
      if (t === 'ALL' && (kwRegion(m, f) || kwPartner(m, f))) return true;
      if (t === 'MISSION') return false;
    }
    // 라이더 검색 → 해당 라이더가 참여한 미션만
    return MOCK.participants.some(function (p) { return p.missionId === m.id && kwRider(p, f); });
  }
  function kwRider(p, f) {
    if (!f.keyword) return true;
    var t = f.keywordType || 'ALL', k = f.keyword.toUpperCase();
    if (t === 'RIDER_CODE') return p.riderId.toUpperCase().indexOf(k) >= 0;
    if (t === 'RIDER_NAME') return p.riderName.indexOf(f.keyword) >= 0;
    if (t === 'MISSION' || t === 'REGION' || t === 'PARTNER' || t === 'ORDER_NO' || t === 'ORDER_EXT') return true;   // 미션명/지역/화주사/주문번호/주문아이디는 다른 단계에서 거름
    return p.riderId.toUpperCase().indexOf(k) >= 0 || p.riderName.indexOf(f.keyword) >= 0;
  }

  function mockMissionRows(f) {
    return MOCK.missions.filter(function (m) { return matchesMission(m, f); })
      .filter(function (m) { return kwMission(m, f); })
      .map(MOCK.aggregate);
  }

  function mockParticipantRows(f) {
    var mset = {};
    MOCK.missions.filter(function (m) { return matchesMission(m, f); })
      .filter(function (m) { if (!f.keyword) return true; if (f.keywordType === 'MISSION') return m.title.indexOf(f.keyword) >= 0; if (f.keywordType === 'REGION') return kwRegion(m, f); if (f.keywordType === 'PARTNER') return kwPartner(m, f); return true; })
      .forEach(function (m) { mset[m.id] = m; });
    return MOCK.participants.filter(function (p) { return mset[p.missionId]; })
      .filter(function (p) {
        if (f.dateBasis === 'paid') {           // 지급일 기준: 기간 내 지급된 건만
          if (!p.paidAt) return false;
          var pd = fmtDate(new Date(p.paidAt));
          if (pd < f.from || pd > f.to) return false;
        }
        if (f.agencyId && p.agencyId !== f.agencyId) return false;
        if (f.keyword) {
          var t = f.keywordType || 'ALL';
          if (t === 'ALL') {
            // 미션명 또는 라이더 어느 쪽이든 매칭
            if (mset[p.missionId].title.indexOf(f.keyword) < 0 && !kwRegion(mset[p.missionId], f) && !kwPartner(mset[p.missionId], f) && !kwRider(p, f)) return false;
          } else if (!kwRider(p, f)) return false;
        }
        if (f.result === 'COMPLETED' && !(p.tierCount && p.status !== 'CANCELLED')) return false;
        if (f.result === 'INCOMPLETE' && p.tierCount) return false;
        if (f.result === 'CANCELLED' && p.status !== 'CANCELLED') return false;
        if (f.result === 'PENDING' && p.status !== 'PENDING') return false;
        if (f.result === 'PAID' && p.status !== 'PAID') return false;
        if (f.result === 'CLOSED' && p.status !== 'CLOSED') return false;
        if (f.rejectOnly && !p.rejected) return false;
        return true;
      })
      .map(function (p) {
        var m = mset[p.missionId];
        return $.extend({}, p, {
          missionTitle: m.title,
          missionStatus: MOCK.missionStatus(m),
          partnerNames: m.partnerIds.map(function (id) { return MOCK.partnerById(id).name; }),
          agencyName: MOCK.agencyById(p.agencyId).name,
          regionName: MOCK.regionLabel(MOCK.regionById(m.regionId)),
          regionTip: MOCK.regionTip(MOCK.regionById(m.regionId)),
          tiers: m.tiers,
          minTier: m.tiers[0].count,
          acceptRate: pct(p.accepted, p.performed),
          periodStart: m.periodStart, periodEnd: m.periodEnd,
          type: m.type, limitMin: m.limitMin, countingCond: m.countingCond
        });
      });
  }

  /* 주문별: 참여자 → 주문 평탄화 (필터 키로 캐시) */
  var orderCache = { key: null, rows: [] };
  function mockOrderRows(f) {
    var base = $.extend({}, f, { result: '', rejectOnly: false, accepted: '', keyword: (f.keywordType === 'ORDER_NO' || f.keywordType === 'ORDER_EXT' || f.keywordType === 'ALL') ? '' : f.keyword });
    var key = JSON.stringify(base);
    if (orderCache.key !== key) {
      var rows = [];
      mockParticipantRows(base).forEach(function (p) {
        var m = MOCK.missionById(p.missionId);
        var isDispatch = m.type === 'DISPATCH';
        MOCK.ordersFor(p).forEach(function (o) {
          var dR = (o.receivedAt && o.completedAt) ? Math.round((o.completedAt - o.receivedAt) / 60000) : null;
          var dD = (o.dispatchedAt && o.completedAt) ? Math.round((o.completedAt - o.dispatchedAt) / 60000) : null;
          var key2 = isDispatch ? dD : dR;
          rows.push($.extend({}, o, {
            participantId: p.id, riderId: p.riderId, riderName: p.riderName, agencyId: p.agencyId, agencyName: p.agencyName, hubName: p.hubName, hubCode: p.hubCode,
            missionId: m.id, missionTitle: m.title, missionStatus: p.missionStatus, missionType: m.type, limitMin: m.limitMin,
            regionName: p.regionName, regionTip: p.regionTip, partnerNames: p.partnerNames,
            dRcv: dR, dDsp: dD, over: (m.limitMin && key2 != null && key2 > m.limitMin) ? key2 - m.limitMin : 0
          }));
        });
      });
      orderCache = { key: key, rows: rows };
    }
    var kw = f.keyword ? f.keyword.toUpperCase() : '';
    return orderCache.rows.filter(function (o) {
      if (f.accepted === 'Y' && !o.accepted) return false;
      if (f.accepted === 'N' && o.accepted) return false;
      if (kw && f.keywordType === 'ORDER_NO') return o.orderNo.indexOf(kw) >= 0;
      if (kw && f.keywordType === 'ORDER_EXT') return (o.orderExtId || '').toUpperCase().indexOf(kw) >= 0;
      if (kw && f.keywordType === 'ALL') {
        return o.orderNo.indexOf(kw) >= 0 || (o.orderExtId || '').toUpperCase().indexOf(kw) >= 0 || o.riderId.indexOf(kw) >= 0 || o.riderName.indexOf(f.keyword) >= 0 ||
               o.missionTitle.indexOf(f.keyword) >= 0 || o.regionName.indexOf(f.keyword) >= 0 || (o.partnerNames || []).join(',').indexOf(f.keyword) >= 0;
      }
      return true;
    });
  }

  /* 참여 목록 → 라이더 행. 참여 1건이면 참여 객체 그대로(기존 렌더), 2건 이상이면 합계 행 + participations */
  function mockRiderRows(parts) {
    var byRider = {}, order = [];
    parts.forEach(function (p) { if (!byRider[p.riderId]) { byRider[p.riderId] = []; order.push(p.riderId); } byRider[p.riderId].push(p); });
    return order.map(function (rid) {
      var list = byRider[rid];
      if (list.length === 1) return list[0];
      list.sort(function (a, b) { return a.periodStart < b.periodStart ? 1 : -1; });
      var f = list[0], agg = { performed: 0, accepted: 0, rejected: 0, reward: 0, completedCount: 0, paid: 0, pending: 0, cancelled: 0, closed: 0, paidAt: null };
      list.forEach(function (p) {
        agg.performed += p.performed; agg.accepted += p.accepted; agg.rejected += p.rejected;
        if (p.tierCount && p.status !== 'CANCELLED' && p.status !== 'CLOSED') { agg.completedCount++; agg.reward += p.reward; }
        if (p.status === 'PAID') agg.paid++; if (p.status === 'PENDING') agg.pending++; if (p.status === 'CANCELLED') agg.cancelled++; if (p.status === 'CLOSED') agg.closed++;
        if (p.paidAt && (!agg.paidAt || p.paidAt > agg.paidAt)) agg.paidAt = p.paidAt;
      });
      return $.extend({}, agg, {
        id: 'R' + rid, riderId: rid, riderName: f.riderName, agencyId: f.agencyId, agencyName: f.agencyName, hubName: f.hubName, hubCode: f.hubCode,
        participations: list, count: list.length,
        missionTitle: list.map(function (p) { return p.missionTitle; }).join(' / '),
        missionStatus: list.some(function (p) { return p.missionStatus === 'RUNNING'; }) ? 'RUNNING' : 'ENDED',
        tierCount: agg.completedCount, status: agg.pending ? 'PENDING' : (agg.paid ? 'PAID' : (agg.cancelled ? 'CANCELLED' : 'NONE')),
        periodStart: f.periodStart
      });
    });
  }

  function sortRows(rows, sort) {
    var f = sort.field, dir = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var x = a[f], y = b[f], r;
      if (x == null && y == null) r = 0;
      else if (x == null) return 1; else if (y == null) return -1;
      else r = (typeof x === 'string') ? x.localeCompare(y) * dir : ((+x) - (+y)) * dir;
      // 동순위면 적용 기간 최신순
      if (r === 0 && a.periodStart && b.periodStart) r = a.periodStart < b.periodStart ? 1 : (a.periodStart > b.periodStart ? -1 : 0);
      return r;
    });
  }

  var API = {
    summary: function (f) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/summary', f);
      var rows = mockMissionRows(f);
      var s = { missions: rows.length, participants: 0, performed: 0, accepted: 0, completed: 0, paid: 0, unknown: 0, byStatus: { RUNNING: 0, BEFORE: 0, ENDED: 0 } };
      rows.forEach(function (r) { s.byStatus[r.status]++; });
      rows.forEach(function (r) { s.participants += r.participants; s.performed += r.performed; s.accepted += r.accepted; s.completed += r.completed; s.paid += r.paid; s.unknown += r.unknown; });
      s.completeRate = pct(s.accepted, s.performed);          // 완료율 = Σ인정건 ÷ Σ수행건
      s.acceptRate = pct(s.accepted, s.performed);
      return delay(s);
    },
    byMission: function (f, page, size, sort) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/by-mission', $.extend({}, f, { page: page, size: size, sort: sort.field + ',' + sort.dir }));
      var rows = sortRows(mockMissionRows(f), sort);
      return delay({ totalElements: rows.length, content: rows.slice((page - 1) * size, page * size),
        totals: { cancelled: rows.reduce(function (a, r) { return a + r.cancelled; }, 0), unknown: rows.reduce(function (a, r) { return a + r.unknown; }, 0) } });
    },
    byParticipant: function (f, page, size, sort) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/by-participant', $.extend({}, f, { page: page, size: size, sort: sort.field + ',' + sort.dir }));
      var all = mockParticipantRows(f);            // 참여(라이더×미션) 단위
      var riders = mockRiderRows(all);              // 라이더 단위로 묶음
      var rows = sortRows(riders, sort);
      var t = { participations: all.length, completed: 0, incomplete: 0, cancelled: 0, withReject: 0, closed: 0, multi: 0 };
      all.forEach(function (p) { if (p.status === 'CANCELLED') t.cancelled++; else if (p.status === 'CLOSED') t.closed++; else if (p.tierCount) t.completed++; else t.incomplete++; if (p.rejected) t.withReject++; });
      riders.forEach(function (r) { if (r.participations) t.multi++; });
      return delay({ totalElements: rows.length, content: rows.slice((page - 1) * size, page * size), totals: t });
    },
    byOrder: function (f, page, size, sort) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/by-order', $.extend({}, f, { page: page, size: size, sort: sort.field + ',' + sort.dir }));
      var all = mockOrderRows(f);
      var rows = sortRows(all, sort);
      var t = { accepted: 0, rejected: 0 };
      all.forEach(function (o) { if (o.accepted) t.accepted++; else t.rejected++; });
      return delay({ totalElements: rows.length, content: rows.slice((page - 1) * size, page * size), totals: t }, state.exporting ? 0 : 200);
    },
    orderCount: function (f) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/by-order/count', f);
      return delay({ count: mockOrderRows($.extend({}, f, { accepted: '', keyword: '' })).length }, 60);
    },
    participantCount: function (f) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/by-participant/count', f);
      return delay({ count: mockRiderRows(mockParticipantRows($.extend({}, f, { result: '', rejectOnly: false, keyword: '' }))).length }, 50);
    },
    orders: function (missionId, participantId) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/' + missionId + '/participants/' + participantId + '/orders');
      var p = null; MOCK.participants.forEach(function (x) { if (x.id === participantId) p = x; });
      var m = MOCK.aggregate(MOCK.missionById(missionId));
      return delay({ content: p ? MOCK.ordersFor(p) : [], mission: m, participant: p }, state.exporting ? 0 : 260);
    },
    cancel: function (participantId, reason) {
      if (!CONFIG.USE_MOCK) return $.ajax({ type: 'POST', url: CONFIG.API_BASE + '/' + participantId + '/cancel', contentType: 'application/json', data: JSON.stringify({ reason: reason }) });
      MOCK.participants.forEach(function (x) {
        if (x.id === participantId) { x.status = 'CANCELLED'; x.cancelledAt = new Date(); x.cancelledBy = '나'; x.cancelReason = reason; }
      });
      return delay({ ok: true }, 300);
    },
    missionDetail: function (missionId) {
      if (!CONFIG.USE_MOCK) return $.getJSON(CONFIG.API_BASE + '/' + missionId);
      var m = MOCK.missionById(missionId);
      return delay(m ? MOCK.aggregate(m) : null, 120);
    },
    exportUrl: function (f, tab) {
      return CONFIG.API_BASE + '/export?' + $.param($.extend({}, f, { tab: tab }));
    }
  };

  /* ---------------------------------------------------------
     필터 읽기 / 검증
  --------------------------------------------------------- */
  function readFilters() {
    return {
      from: $('#mcFrom').val(),
      to: $('#mcTo').val(),
      partnerIds: ($('#mcPartner').val() || []).filter(function (v) { return v !== 'ALL'; }).map(Number),   // 복수 선택 ('ALL' = 전체)
      agencyId: $('#mcAgency').val() || '',
      missionType: $('#mcType').val() || '',
      status: $('#mcStatus').val() || '',
      kind: $('#mcKind').val() || '',                              // PERIOD | DAILY | WEEKLY | MONTHLY | WEEKDAY
      keyword: $.trim($('#mcKeyword').val()),
      keywordType: $('#mcKeywordType').val() || 'ALL',   // ALL | MISSION | REGION | PARTNER | RIDER_CODE | RIDER_NAME
      result: $('#mcResult').val() || '',
      rejectOnly: $('#mcRejectOnly').is(':checked'),
      accepted: $('#mcAccepted').val() || '',                    // 주문별: '' | Y | N
      dateBasis: 'operation',                                     // operation(운영기준일) | paid(지급일) — 다운로드 팝업에서 변경
      missionId: state.mission ? state.mission.id : ''
    };
  }

  function validateFilters(f) {
    if (!f.from || !f.to) { Swal.fire({ icon: 'warning', title: '기간을 입력해주세요.' }); return false; }
    if (f.from > f.to) { Swal.fire({ icon: 'warning', title: '시작일이 종료일보다 늦습니다.' }); return false; }
    if (daysBetween(f.from, f.to) > CONFIG.MAX_RANGE_DAYS) {
      Swal.fire({ icon: 'warning', title: '조회 기간은 최대 ' + CONFIG.MAX_RANGE_DAYS + '일까지 가능합니다.' }); return false;
    }
    return true;
  }

  /* 미션 고정 칩 (참여자 탭) */
  function renderMissionChip() {
    var $chip = $('#mcMissionChip');
    if (state.mission) $chip.show().find('.js-chip-title').text(state.mission.title);
    else $chip.hide();
  }

  /* ---------------------------------------------------------
     렌더 — KPI
  --------------------------------------------------------- */
  function renderKpis(s) {
    $kpis.removeClass('is-loading');
    $('#kpiMissions').text(comma(s.missions));
    var bs = s.byStatus || {};
    $('#kpiMissionsSub').html('진행중 <b>' + comma(bs.RUNNING || 0) + '</b> · 시작전 <b>' + comma(bs.BEFORE || 0) + '</b> · 완료 <b>' + comma(bs.ENDED || 0) + '</b>');
    $('#mcUpdatedAt').text(fmtDateTime(new Date()).slice(5));
    $('#kpiParticipants').text(comma(s.participants));
    $('#kpiCompleted').text(comma(s.completed));
    $('#kpiCompleteRate').text(s.completeRate == null ? '—' : s.completeRate.toFixed(1));
    $('#kpiPaid').text(comma(s.paid));
  }

  /* ---------------------------------------------------------
     렌더 — 테이블 헤더
  --------------------------------------------------------- */
  var COLS = {
    mission: [
      { key: 'title',        label: '미션명',     cls: 'mc-name', sortable: true },
      { key: 'statusRank',   label: '상태',       sortable: true },
      { key: 'kindLabel',    label: '미션 타입',  sortable: true },
      { key: 'agencyLabel',  label: '배달대행사', sortable: true },
      { key: 'limitMin',     label: '완료카운팅 조건', sortable: true },
      { key: 'periodStart',  label: '적용 기간',  sortable: true },
      { key: 'performed',    label: '수행건',    cls: 'num', sortable: true },
      { key: 'accepted',     label: '인정건',    cls: 'num', sortable: true },
      { key: 'completeRate', label: '완료율',    sortable: true },
      { key: 'participants', label: '참여인원',  cls: 'num', sortable: true },
      { key: 'completed',    label: '달성인원',  cls: 'num', sortable: true },
      { key: 'paid',         label: '지급금액',  cls: 'num', sortable: true },
      { key: '_detail',      label: '',          cls: 'center' }
    ],
    participant: [
      { key: 'riderName',    label: '라이더',     sortable: true },
      { key: 'agencyName',   label: '배달대행사', sortable: true },
      { key: 'missionTitle', label: '미션명',     sortable: true },
      { key: 'performed',    label: '수행건',     cls: 'num', sortable: true },
      { key: 'accepted',     label: '인정건',     cls: 'num', sortable: true },
      { key: 'rejected',     label: '미인정건',   cls: 'num', sortable: true },
      { key: 'tierCount',    label: '달성 단계',  sortable: true },
      { key: 'reward',       label: '지급금액',   cls: 'num', sortable: true },
      { key: 'paidAt',       label: '지급시간',   sortable: true },
      { key: 'tierCount',    label: '달성',       sortable: true },
      { key: 'status',       label: '지급',       sortable: true },
      { key: '_manage',      label: '관리',       cls: 'center' }
    ],
    order: [
      { key: 'missionTitle', label: '미션명',       sortable: true },
      { key: 'orderNo',      label: '주문번호',     sortable: true },
      { key: 'orderExtId',   label: '주문제휴사 주문아이디' },
      { key: 'partner',      label: '주문 제휴사',  sortable: true },
      { key: 'storeName',    label: '상점명',       sortable: true },
      { key: 'region',       label: '지역',         sortable: true },
      { key: 'riderName',    label: '라이더',       sortable: true },
      { key: 'agencyName',   label: '배달대행사',   sortable: true },
      { key: 'receivedAt',   label: '접수',         sortable: true },
      { key: 'dispatchedAt', label: '배정',         sortable: true },
      { key: 'pickedAt',     label: '픽업' },
      { key: 'completedAt',  label: '완료',         sortable: true },
      { key: 'cancelledAt',  label: '취소' },
      { key: 'dRcv',         label: '접수기준',     cls: 'num', sortable: true },
      { key: 'dDsp',         label: '배정기준',     cls: 'num', sortable: true },
      { key: 'accepted',     label: '인정',         sortable: true },
      { key: 'rejectReason', label: '미인정 사유',  sortable: true }
    ]
  };

  function renderHead() {
    var sort = state.sort[state.tab];
    var h = COLS[state.tab].map(function (c) {
      var cls = [c.cls || ''];
      if (c.sortable) cls.push('is-sortable');
      if (sort.field === c.key) cls.push(sort.dir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      return '<th class="' + cls.join(' ') + '"' + (c.sortable ? ' data-sort="' + c.key + '"' : '') + '>' + esc(c.label) + '</th>';
    }).join('');
    $thead.html('<tr>' + (state.tab === 'participant' ? '<th style="width:28px"></th>' : '') + h + '</tr>');
  }

  function colCount() { return COLS[state.tab].length + (state.tab === 'participant' ? 1 : 0); }

  function renderSkeleton() {
    var cols = colCount(), rows = [];
    for (var i = 0; i < 6; i++) {
      var tds = [];
      for (var j = 0; j < cols; j++) tds.push('<td><span style="width:' + (40 + ((i + j) % 4) * 15) + '%"></span></td>');
      rows.push('<tr class="mc-skeleton">' + tds.join('') + '</tr>');
    }
    $tbody.html(rows.join(''));
  }

  function renderEmpty() {
    $tbody.html('<tr><td colspan="' + colCount() + '"><div class="mc-empty"><i class="xi-file-o"></i>해당 조건에 미션이 없습니다.' +
      '<br><button type="button" class="mc-btn mc-btn--ghost mc-btn--sm" id="mcWiden">기간 30일로 넓혀보기</button></div></td></tr>');
  }

  /* ---------------------------------------------------------
     렌더 — 미션별
  --------------------------------------------------------- */
  /* 완료카운팅 조건: 접수 후 N분 / 배차 후 N분 / 없음 */
  function typeBadge(type, limitMin) {
    // 배달대행사 뱃지와 같은 아웃라인 형태, 색만 구분 — 접수 후(블루) / 배차 후(앰버) / 없음(그레이)
    if (!limitMin) return '<span class="mc-badge mc-cond mc-cond--none">없음</span>';
    var txt = TYPE_LABEL[type] + ' ' + limitMin + '분';
    return '<span class="mc-badge mc-cond ' + (type === 'DISPATCH' ? 'mc-cond--dispatch' : 'mc-cond--receipt') + '">' + txt + '</span>';
  }

  /* 적용 지역: '외 N개'면 마우스 오버 시 전체 목록 */
  function regionSpan(label, tip) {
    if (!tip) return '<span title="적용 지역">' + esc(label) + '</span>';
    return '<span class="mc-region mc-tip" title="' + esc(tip) + '">' + esc(label) + '</span>';
  }

  /* 완료카운팅 조건 셀: 시간 조건(접수/배차 후 N분) + 거리 + 권역 을 위아래로 */
  function countingCell(r) {
    var items = [];
    if (r.limitMin) items.push(typeBadge(r.type, r.limitMin));
    if (r.countingCond && r.countingCond.distance) items.push('<span class="mc-badge mc-cond mc-cond--distance">거리 ' + comma(r.countingCond.distance) + 'm 이상</span>');
    if (r.countingCond && r.countingCond.zone) items.push('<span class="mc-badge mc-cond mc-cond--zone">권역</span>');
    if (!items.length) return typeBadge(r.type, 0);   // 없음
    return '<div class="mc-stack">' + items.join('') + '</div>';
  }
  function countingText(r) {
    var t = [];
    if (r.limitMin) t.push(TYPE_LABEL[r.type] + ' ' + r.limitMin + '분');
    if (r.countingCond && r.countingCond.distance) t.push('거리 ' + comma(r.countingCond.distance) + 'm 이상');
    if (r.countingCond && r.countingCond.zone) t.push('권역');
    return t.length ? t.join(' / ') : '없음';
  }

  /* 부가 조건 뱃지 — 선착순은 소진 현황(N명 지급 / 마감) 포함 */
  function condBadges(conds) {
    return (conds || []).map(function (c) {
      var cls = 'mc-cond2 mc-cond2--' + c.key + (c.closed ? ' is-closed' : '');
      var title = c.key === 'firstCome' ? '달성 시각 순으로 ' + esc(c.text.replace('선착순 ', '')) + '까지만 지급' : '';
      return '<span class="mc-badge ' + cls + '" title="' + title + '">' + esc(c.text) + (c.sub ? ' <small>· ' + esc(c.sub) + '</small>' : '') + '</span>';
    }).join('');
  }

  /* 미션 타입 뱃지: 기간한정(그레이 아웃라인) / 반복 계열(퍼플 아웃라인) */
  function kindBadge(key, label, sub) {
    var badge = '<span class="mc-badge mc-kind ' + (key === 'PERIOD' ? 'mc-kind--period' : 'mc-kind--repeat') + '">' + esc(label) + '</span>';
    if (!sub) return badge;
    // 요일 목록은 뱃지 아래 줄, 뱃지 폭 기준 가운데 정렬
    return '<span class="mc-kind-wrap">' + badge + '<span class="mc-kind__sub">' + esc(sub) + '</span></span>';
  }

  /* 상태 뱃지: 진행중(블루 채움) / 시작전(그레이 아웃라인) / 종료(블랙 채움 — 기존 카드의 '종료됨' 톤) */
  function statusBadge(status, progress) {
    var st = STATUS_LABEL[status] || STATUS_LABEL.ENDED;
    return '<span class="mc-badge mc-status ' + st.cls + '">' + st.text + '</span>';   // 진행률은 적용 기간 아래 진행바로만
  }

  /* 배달대행사 뱃지: 모두 아웃라인 형태, 색만 구분 — 그라이더(블루) / 그라이더플러스(그린) / 전체(그레이) */
  function agencyBadge(agencyIds, label) {
    var cls = 'mc-agency--all';
    if (label !== '전체') cls = (agencyIds.length === 1 && agencyIds[0] === 'GRP') ? 'mc-agency--grp' : 'mc-agency--gr';
    return '<span class="mc-badge mc-agency ' + cls + '">' + esc(label) + '</span>';
  }

  function renderMissionRows(rows) {
    if (!rows.length) return renderEmpty();
    var html = rows.map(function (r) {
      var before = r.status === 'BEFORE', running = r.status === 'RUNNING';
      var flag = !before && r.completeRate != null && r.completeRate < 70;   // 완료율 70% 미만 → 카운팅 누락 의심
      var trCls = [];
      if (flag) trCls.push('is-flag');
      else if (!before && !running && r.completed === 0) trCls.push('is-zero');
      if (running) trCls.push('is-running');
      var dash = '<span class="muted">—</span>';
      var num = function (v, cls) { return before ? dash : '<span class="' + (cls || '') + '">' + comma(v) + '</span>'; };
      return '<tr class="' + trCls.join(' ') + '" data-id="' + r.id + '">' +
        '<td class="mc-name">' +
          '<div class="mc-name__title"><a href="#" class="mc-link js-mission-open" data-id="' + r.id + '">' + esc(r.title) + '</a>' +
            (r.cancelled ? ' <span class="mc-badge mc-badge--red mc-badge--inline" title="지급 취소된 참여자 ' + r.cancelled + '명"><i class="xi-error"></i> 지급취소 ' + r.cancelled + '건</span>' : '') +
          '</div>' +
          '<div class="mc-name__sub">' +
            '<span title="주문 제휴사">' + esc(listLabel(r.partnerNames)) + '</span><span>·</span>' +
            regionSpan(r.regionName, r.regionTip) +
          '</div>' +
          // 3줄 고정: 제목 / 제휴사 · 지역 / 지급 단계
          '<div class="mc-name__tiers"><span class="mc-badge mc-badge--gray" title="지급 단계 (최상위 1개 지급)">' + esc(tiersLabel(r.tiers)) + '</span>' + condBadges(r.conds) + '</div>' +
        '</td>' +
        '<td>' + statusBadge(r.status, r.progress) + '</td>' +
        '<td>' + kindBadge(r.kindKey, r.kindLabel, r.kindSub) + '</td>' +
        '<td>' + agencyBadge(r.agencyIds, r.agencyLabel) + '</td>' +
        '<td>' + countingCell(r) + '</td>' +
        '<td>' + fmtPeriod(r.periodStart, r.periodEnd) +
          (running ? '<div class="mc-progress" title="적용 기간 경과 ' + r.progress + '%"><div class="mc-progress__fill" style="width:' + r.progress + '%"></div></div>' : '') + '</td>' +
        '<td class="num">' + num(r.performed) + '</td>' +
        '<td class="num">' + num(r.accepted, flag ? 'danger' : '') + '</td>' +
        '<td>' + (before ? dash : barHtml(r.completeRate, { low: 90, bad: 70 })) + '</td>' +
        '<td class="num">' + num(r.participants) + '</td>' +
        '<td class="num">' + num(r.completed, 'strong') + '</td>' +
        '<td class="num">' + (before ? dash : '<span class="' + (running ? 'muted' : 'strong') + '" title="' + (running ? '진행 중 — 현재까지 지급된 금액' : '') + '">' + comma(r.paid) + '</span>') + '</td>' +
        '<td class="center"><button type="button" class="mc-btn mc-btn--green mc-btn--sm js-mission-detail" data-id="' + r.id + '" data-title="' + esc(r.title) + '"' + (before ? ' disabled title="시작 전 미션"' : '') + '>참여자 보기</button></td>' +
      '</tr>';
    }).join('');
    $tbody.html(html);
  }

  /* ---------------------------------------------------------
     렌더 — 주문별 (미션 카운팅 기준 컬럼 강조는 행별 미션 타입에 따름)
  --------------------------------------------------------- */
  function renderOrderRows(rows) {
    if (!rows.length) return renderEmpty();
    var html = rows.map(function (o) {
      var isD = o.missionType === 'DISPATCH';
      var t = function (d, key) { return d ? '<td class="' + (key ? 'is-key' : '') + '">' + fmtDateTime(d).slice(5) + '</td>' : '<td class="muted">—</td>'; };
      var dur = function (v, key) {
        if (v == null) return '<td class="num muted">—</td>';
        return '<td class="num ' + (key ? 'is-key' : 'muted') + (key && o.over ? ' danger' : '') + '">' + v + '분' + (key && o.over ? ' <small>(+' + o.over + ')</small>' : '') + '</td>';
      };
      var reason = o.accepted ? '<span class="muted">—</span>'
        : (o.rejectReason === 'TIME_LIMIT_EXCEEDED'
            ? '수행시간 초과 <span class="danger">+' + (o.over || '?') + '분</span> <span class="muted">(' + (isD ? '배정' : '접수') + ' 후 ' + o.limitMin + '분)</span>'
            : '<span class="' + (o.rejectReason === 'UNKNOWN' ? 'danger' : '') + '">' + esc(REJECT[o.rejectReason] || o.rejectReason || '') + '</span>' + (o.note ? ' <span class="muted">(' + esc(o.note) + ')</span>' : ''));
      return '<tr class="' + (o.accepted ? '' : 'is-flag') + '" data-participant="' + o.participantId + '" data-mission="' + o.missionId + '">' +
        '<td class="mc-name" style="min-width:180px">' + esc(o.missionTitle) + (o.missionStatus === 'RUNNING' ? ' ' + statusBadge('RUNNING') : '') +
          '<div class="mc-name__sub">' + typeBadge(o.missionType, o.limitMin) + regionSpan(o.regionName, o.regionTip) + '</div></td>' +
        '<td><a href="#" class="mc-order-no" title="주문 상세">' + esc(o.orderNo) + '</a></td>' +
        '<td class="mc-order-ext">' + esc(o.orderExtId || '') + '</td>' +
        '<td' + (o.rejectReason === 'PARTNER_MISMATCH' ? ' class="danger"' : '') + '>' + esc(o.partner) + '</td>' +
        '<td>' + esc(o.storeName || '') + '</td>' +
        '<td' + (o.rejectReason === 'REGION_MISMATCH' ? ' class="danger"' : '') + '>' + esc(o.region) + '</td>' +
        '<td><span class="strong">' + esc(o.riderName) + '</span><div class="mc-rider__id">' + esc(o.riderId) + '</div></td>' +
        '<td>' + agencyBadge([o.agencyId], o.agencyName) + '</td>' +
        t(o.receivedAt, !isD) + t(o.dispatchedAt, isD) + t(o.pickedAt, false) + t(o.completedAt, true) +
        (o.cancelledAt ? '<td class="danger">' + fmtDateTime(o.cancelledAt).slice(5) + '</td>' : '<td class="muted">—</td>') +
        dur(o.dRcv, !isD) + dur(o.dDsp, isD) +
        '<td>' + (o.accepted ? '<span class="mc-badge mc-badge--green">인정</span>' : '<span class="mc-badge mc-badge--red">미인정</span>') + '</td>' +
        '<td style="white-space:nowrap">' + reason + '</td>' +
      '</tr>';
    }).join('');
    $tbody.html(html);
  }

  /* ---------------------------------------------------------
     렌더 — 참여자별
  --------------------------------------------------------- */
  /* 참여(라이더×미션) 1건의 셀 HTML 묶음 — 단일 행과 하위 미션 목록에서 공용 */
  function participationCells(p) {
      var completed = !!p.tierCount;
      var running = p.missionStatus === 'RUNNING';
      var achieveCell = completed
        ? '<span class="mc-badge mc-badge--green">달성</span>'
        : (running ? '<span class="mc-badge mc-status mc-status--running">진행중</span>' : '<span class="mc-badge mc-badge--gray">미달성</span>');
      var payCell = '<span class="muted">—</span>';
      if (completed && PAY_LABEL[p.status]) {
        var pl = PAY_LABEL[p.status], tip = '';
        if (p.status === 'PENDING') tip = (p.isTopTier ? '최고 단계 달성 · 즉시 지급' : '익일 00:30 일괄 지급') + ' 예정 — ' + fmtDateTime(p.payDueAt);
        if (p.status === 'PAID') tip = (p.isTopTier ? '최고 단계 달성 · 즉시 지급' : '익일 00:30 일괄 지급') + ' — ' + fmtDateTime(p.paidAt);
        if (p.status === 'CANCELLED') tip = '취소 ' + fmtDateTime(p.cancelledAt) + ' · ' + (p.cancelledBy || '') + '\n사유: ' + (p.cancelReason || '-');
        if (p.status === 'CLOSED') tip = '선착순 인원이 먼저 소진되어 지급 대상에서 제외 (달성 ' + fmtDateTime(p.achievedAt) + ')';
        payCell = '<span class="mc-badge ' + pl.cls + ' mc-tip" title="' + esc(tip) + '">' + pl.text + (p.status === 'PENDING' ? ' <i class="xi-time"></i>' : '') + '</span>';
      }
      var trCls = ['is-clickable'];
      if (p.rejected > p.accepted) trCls.push('is-flag');
      if (state.openRows[p.id]) trCls.push('is-open');
      var rejCls = p.rejected === 0 ? 'muted' : (p.rejected > p.accepted ? 'danger' : 'warn');

      // 달성 단계: "2단계 · 7건" / 미달이면 다음 단계까지 남은 건수
      var tierCell;
      if (completed) {
        var idx = 0; p.tiers.forEach(function (t, i) { if (t.count === p.tierCount) idx = i + 1; });
        tierCell = '<span class="strong">' + idx + '단계</span> <span class="muted">· ' + p.tierCount + '건</span>';
      } else {
        tierCell = '<span class="muted">미달 · 1단계까지 ' + (p.minTier - p.accepted) + '건</span>';
      }
      var rewardCell = !completed ? '<span class="muted">—</span>'
        : (p.status === 'CANCELLED' ? '<span class="strike">' + comma(p.reward) + '</span>'
        : (p.status === 'CLOSED' ? '<span class="muted" title="선착순 마감 — 미지급">' + comma(p.reward) + '</span>' : '<span class="strong">' + comma(p.reward) + '</span>'));
      var manage = '';
      if ((p.status === 'PAID' || p.status === 'PENDING') && p.missionStatus === 'ENDED') {
        // 오클릭 방지: 바로 노출하지 않고 ⋮ 메뉴 안에 '미션 취소'
        manage = '<button type="button" class="mc-kebab js-kebab" data-id="' + p.id + '" title="관리 메뉴" aria-haspopup="true"><i class="xi-ellipsis-v"></i></button>';
      } else if ((p.status === 'PAID' || p.status === 'PENDING') && running) {
        manage = '<span class="muted" style="font-size:11.5px" title="미션 종료 후 취소 가능">진행중</span>';
      } else if (p.status === 'CANCELLED') {
        manage = '<span class="muted mc-tip" style="font-size:11.5px" title="' + esc('사유: ' + (p.cancelReason || '-')) + '">' + esc(fmtDateTime(p.cancelledAt).slice(5, 16) + ' ' + (p.cancelledBy || '')) + '</span>';
      } else {
        manage = '<button type="button" class="mc-btn mc-btn--ghost mc-btn--sm js-toggle-orders" data-id="' + p.id + '">주문 보기</button>';
      }
      var paidCell = '<td class="' + (p.status === 'CANCELLED' ? 'muted' : '') + '">' + (p.paidAt ? fmtDateTime(p.paidAt) : (p.status === 'PENDING' ? '<span class="muted mc-tip" title="지급 예정 ' + esc(fmtDateTime(p.payDueAt)) + '">예정</span>' : '<span class="muted">—</span>')) + '</td>';
      var missionCell = esc(p.missionTitle) + (running ? ' ' + statusBadge('RUNNING') : '') +
          '<div class="mc-name__sub"><span title="주문 제휴사">' + esc(listLabel(p.partnerNames)) + '</span><span>·</span>' + regionSpan(p.regionName, p.regionTip) + '</div>';
      var stats = '<td class="num">' + comma(p.performed) + '</td>' +
        '<td class="num strong">' + comma(p.accepted) + '</td>' +
        '<td class="num ' + rejCls + '">' + comma(p.rejected) + '</td>' +
        '<td>' + tierCell + '</td>' +
        '<td class="num">' + rewardCell + '</td>' + paidCell +
        '<td>' + achieveCell + '</td>' +
        '<td>' + payCell + '</td>' +
        '<td class="center">' + manage + '</td>';
      return { trCls: trCls, missionCell: missionCell, stats: stats };
  }

  function renderParticipantRows(rows) {
    if (!rows.length) return renderEmpty();
    var html = rows.map(function (p) {
      var riderCell = '<td><span class="strong">' + esc(p.riderName) + '</span><div class="mc-rider__id">' + esc(p.riderId) + '</div></td>' +
                      '<td>' + agencyBadge([p.agencyId], p.agencyName) + '</td>';
      var open = !!state.openRows[p.id];
      var chevron = '<td class="center muted"><i class="xi-angle-' + (open ? 'down' : 'right') + '-min js-chevron"></i></td>';

      if (p.participations) {
        // ---- 여러 미션 참여 라이더: 합계 행. 클릭 → 참여 미션 목록(중간 단계) ----
        var titles = p.participations.map(function (x) { return x.missionTitle; });
        var pays = [];
        if (p.paid) pays.push('지급완료 ' + p.paid); if (p.pending) pays.push('예정 ' + p.pending); if (p.cancelled) pays.push('취소 ' + p.cancelled); if (p.closed) pays.push('선착순 마감 ' + p.closed);
        return '<tr class="is-clickable is-multi' + (open ? ' is-open' : '') + '" data-id="' + p.id + '">' +
          chevron + riderCell +
          '<td><span class="mc-multi"><i class="xi-layers"></i> 미션 <b>' + p.count + '</b>개 참여</span>' +
            '<div class="mc-name__sub"><span>' + esc(titles.slice(0, 2).join(' · ')) + (titles.length > 2 ? ' 외 ' + (titles.length - 2) + '개' : '') + '</span></div></td>' +
          '<td class="num">' + comma(p.performed) + '</td>' +
          '<td class="num strong">' + comma(p.accepted) + '</td>' +
          '<td class="num ' + (p.rejected ? 'warn' : 'muted') + '">' + comma(p.rejected) + '</td>' +
          '<td><span class="strong">' + p.completedCount + '</span><span class="muted"> / ' + p.count + ' 미션 달성</span></td>' +
          '<td class="num strong">' + comma(p.reward) + '</td>' +
          '<td>' + (p.paidAt ? fmtDateTime(p.paidAt) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (p.completedCount ? '<span class="mc-badge mc-badge--green">' + p.completedCount + '/' + p.count + ' 달성</span>' : '<span class="mc-badge mc-badge--gray">미달성</span>') + '</td>' +
          '<td><span class="muted" style="font-size:11.5px">' + esc(pays.join(' · ') || '—') + '</span></td>' +
          '<td class="center"><span class="muted" style="font-size:11.5px" title="미션별 관리는 펼쳐서">▸ 미션별</span></td>' +
        '</tr>';
      }

      // ---- 단일 참여: 기존과 동일 (클릭 → 바로 주문) ----
      var c = participationCells(p);
      return '<tr class="' + c.trCls.join(' ') + '" data-id="' + p.id + '" data-mission="' + p.missionId + '">' +
        chevron + riderCell + '<td>' + c.missionCell + '</td>' + c.stats + '</tr>';
    }).join('');
    $tbody.html(html);
    Object.keys(state.openRows).forEach(function (id) {
      var $tr = $tbody.find('tr[data-id="' + id + '"]');
      if (!$tr.length) return;
      if ($tr.hasClass('is-multi')) openRider($tr); else openOrders($tr, true);
    });
  }

  /* 여러 미션 참여 라이더 펼침: 참여 미션 목록(중간 단계). 미션 행 클릭 → 그 아래 주문 내역 */
  var riderRowCache = {};
  function openRider($tr) {
    var rid = String($tr.data('id'));
    var row = riderRowCache[rid]; if (!row) return;
    var sub = row.participations.map(function (p) {
      var c = participationCells(p);
      return '<tr class="mc-sub__row js-sub-row" data-id="' + p.id + '" data-mission="' + p.missionId + '" data-rider="' + esc(row.riderName + ' ' + row.riderId) + '">' +
        '<td class="center muted"><i class="xi-angle-right-min js-chevron"></i></td>' +
        '<td class="mc-name">' + c.missionCell + '</td>' +
        '<td>' + countingCell(p) + '</td>' +
        '<td>' + fmtPeriod(p.periodStart, p.periodEnd) + '</td>' + c.stats + '</tr>';
    }).join('');
    var $ex = $('<tr class="mc-expand mc-expand--rider" data-for="' + rid + '"><td colspan="' + colCount() + '">' +
      '<div class="mc-sub">' +
        '<div class="mc-sub__head"><b>' + esc(row.riderName) + '</b> <span class="mc-rider__id" style="display:inline">' + esc(row.riderId) + '</span> — 참여 미션 ' + row.count + '개 <span class="muted">· 미션을 선택하면 주문 내역이 아래에 펼쳐집니다</span></div>' +
        '<table><thead><tr><th style="width:28px"></th><th>미션명</th><th>완료카운팅 조건</th><th>적용 기간</th><th class="num">수행건</th><th class="num">인정건</th><th class="num">미인정건</th><th>달성 단계</th><th class="num">지급금액</th><th>지급시간</th><th>달성</th><th>지급</th><th class="center">관리</th></tr></thead>' +
        '<tbody>' + sub + '</tbody></table>' +
      '</div></td></tr>');
    $tr.after($ex).addClass('is-open').find('.js-chevron').removeClass('xi-angle-right-min').addClass('xi-angle-down-min');
    state.openRows[rid] = true;
  }
  function closeRider($tr) {
    var rid = String($tr.data('id'));
    $tbody.find('tr.mc-expand[data-for="' + rid + '"]').remove();
    $tr.removeClass('is-open').find('.js-chevron').removeClass('xi-angle-down-min').addClass('xi-angle-right-min');
    delete state.openRows[rid];
  }
  /* 하위 미션 행 → 주문 내역 토글 */
  function toggleSubOrders($sub) {
    var pid = Number($sub.data('id')), mid = Number($sub.data('mission'));
    var $next = $sub.next('tr.mc-sub__orders');
    if ($next.length) { $next.remove(); $sub.removeClass('is-open').find('.js-chevron').removeClass('xi-angle-down-min').addClass('xi-angle-right-min'); return; }
    $sub.siblings('tr.mc-sub__orders').remove();
    $sub.siblings('.is-open').removeClass('is-open').find('.js-chevron').removeClass('xi-angle-down-min').addClass('xi-angle-right-min');
    var $ex = $('<tr class="mc-sub__orders"><td colspan="13"><div class="mc-orders"><div class="mc-orders__empty">주문 내역을 불러오는 중…</div></div></td></tr>');
    $sub.after($ex).addClass('is-open').find('.js-chevron').removeClass('xi-angle-right-min').addClass('xi-angle-down-min');
    API.orders(mid, pid).done(function (res) {
      $ex.find('.mc-orders').replaceWith(ordersHtml(res.content || [], res.mission || {}, String($sub.data('rider')), res.participant || null));
    });
  }

  /* 주문 단위 펼침 */
  function openOrders($tr) {
    var pid = Number($tr.data('id')), mid = Number($tr.data('mission'));
    var $ex = $('<tr class="mc-expand" data-for="' + pid + '"><td colspan="' + colCount() + '">' +
      '<div class="mc-orders"><div class="mc-orders__empty">주문 내역을 불러오는 중…</div></div></td></tr>');
    $tr.after($ex).addClass('is-open').find('.js-chevron').removeClass('xi-angle-right-min').addClass('xi-angle-down-min');
    state.openRows[pid] = true;
    var $rd = $tr.find('td').eq(1);
    var riderLabel = $rd.find('.strong').text() + ' ' + $rd.find('.mc-rider__id').text();
    API.orders(mid, pid).done(function (res) {
      $ex.find('.mc-orders').replaceWith(ordersHtml(res.content || [], res.mission || {}, riderLabel, res.participant || null));
    });
  }
  function closeOrders($tr) {
    var pid = Number($tr.data('id'));
    $tbody.find('tr.mc-expand[data-for="' + pid + '"]').remove();
    $tr.removeClass('is-open').find('.js-chevron').removeClass('xi-angle-down-min').addClass('xi-angle-right-min');
    delete state.openRows[pid];
  }
  function ordersHtml(list, m, riderLabel, pt) {
    var acc = list.filter(function (o) { return o.accepted; }).length;
    var rej = list.length - acc;
    var name = riderLabel || '';
    var missionType = m.type || 'RECEIPT';
    var isDispatch = missionType === 'DISPATCH';

    var head = '<div class="mc-orders__head"><span><b>' + esc(name) + '</b> — ' + esc(m.title || '') + '</span>' +
      '<span>수행건 <b>' + list.length + '</b> · 인정건 <b style="color:var(--mc-green)">' + acc + '</b> · 미인정건 <b style="color:var(--mc-red)">' + rej + '</b></span></div>';

    // 미션 조건 요약
    var cond = '';
    if (m.title) {
      cond = '<div class="mc-orders__cond">' +
        condItem('적용 기간', fmtPeriod(m.periodStart, m.periodEnd)) +
        condItem('주문 제휴사', (m.partnerNames || []).join(' · ') || '전체') +
        condItem('적용 지역', regionSpan(m.regionName || '전체', m.regionTip)) +
        condItem('배달대행사', m.agencyLabel || '전체') +
        condItem('완료카운팅 조건', m.limitMin ? TYPE_LABEL[missionType] + ' <b>' + m.limitMin + '분</b> 내 완료' : '없음') +
        (pt ? '' : condItem('지원금 단계', (m.tiers || []).map(function (t, i) { return (i + 1) + '단계 ' + t.count + '건 <b>' + comma(t.reward) + '원</b>'; }).join(' / ') + ' <span class="muted">· 최상위 1개 지급</span>')) +
      '</div>';
      if (pt) cond += stepperHtml(m.tiers || [], pt.accepted, pt.tierCount);
    }

    // 지급 / 취소 정보
    var pay = '';
    if (pt && pt.tierCount) {
      var rule = pt.isTopTier ? '최고 단계 달성 → <b>즉시 지급</b>' : '<b>익일 00:30</b> 일괄 지급';
      if (pt.status === 'PAID')      pay = '<div class="mc-orders__pay is-paid"><i class="xi-check-circle"></i> 지급완료 <b>' + fmtDateTime(pt.paidAt) + '</b> · ' + rule + ' · 달성 ' + fmtDateTime(pt.achievedAt) + '</div>';
      if (pt.status === 'PENDING')   pay = '<div class="mc-orders__pay is-pending"><i class="xi-time"></i> 지급예정 <b>' + fmtDateTime(pt.payDueAt) + '</b> · ' + rule + ' · 달성 ' + fmtDateTime(pt.achievedAt) + '</div>';
      if (pt.status === 'CANCELLED') pay = '<div class="mc-orders__pay is-cancel"><i class="xi-error"></i> 지급취소 <b>' + fmtDateTime(pt.cancelledAt) + '</b> · 처리 ' + esc(pt.cancelledBy || '-') + ' · 사유: <b>' + esc(pt.cancelReason || '-') + '</b> <span class="muted">(원 지급 ' + fmtDateTime(pt.paidAt) + ' · ' + comma(pt.reward) + '원 회수)</span></div>';
    }
    cond += pay;

    if (!list.length) return '<div class="mc-orders">' + head + cond + '<div class="mc-orders__empty">수행한 주문이 없습니다.</div></div>';

    var rows = list.map(function (o, i) {
      var reason = o.accepted ? '<span class="muted">—</span>'
        : '<span class="' + (o.rejectReason === 'UNKNOWN' ? 'danger' : '') + '">' + esc(REJECT[o.rejectReason] || o.rejectReason) + '</span>' + (o.note ? ' <span class="muted">(' + esc(o.note) + ')</span>' : '');
      var t = function (d, cls) { return d ? '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + fmtTime(new Date(d)) + '</td>' : '<td class="muted">—</td>'; };
      // 접수기준(접수→완료) / 배정기준(배정→완료) 소요. 미션 타입에 해당하는 쪽을 강조
      var mins = function (a, b) { return (a && b) ? Math.round((new Date(b) - new Date(a)) / 60000) : null; };
      var dRcv = mins(o.receivedAt, o.completedAt), dDsp = mins(o.dispatchedAt, o.completedAt);
      var keyDur = isDispatch ? dDsp : dRcv;
      var over = (m.limitMin && keyDur != null && keyDur > m.limitMin) ? keyDur - m.limitMin : 0;
      if (o.rejectReason === 'TIME_LIMIT_EXCEEDED') {
        reason = '<span>수행시간 초과</span> <span class="danger">+' + (over || '?') + '분</span> <span class="muted">(' + (isDispatch ? '배정' : '접수') + ' 후 ' + m.limitMin + '분 조건)</span>';
      }
      var durCell = function (v, isKey) {
        if (v == null) return '<td class="num muted">—</td>';
        var cls = 'num' + (isKey ? ' is-key' : ' muted') + (isKey && over ? ' danger' : '');
        return '<td class="' + cls + '">' + v + '분' + (isKey && over ? ' <small>(+' + over + ')</small>' : '') + '</td>';
      };
      return '<tr class="' + (o.accepted ? '' : 'is-reject') + '">' +
        '<td class="muted">' + (i + 1) + '</td>' +
        '<td><a href="#" class="mc-order-no" title="주문 상세">' + esc(o.orderNo) + '</a></td>' +
        '<td' + (o.rejectReason === 'PARTNER_MISMATCH' ? ' class="danger"' : '') + '>' + esc(o.partner) + '</td>' +
        '<td class="mc-order-ext">' + esc(o.orderExtId || '') + '</td>' +
        '<td>' + esc(o.storeName || '') + '</td>' +
        '<td' + (o.rejectReason === 'REGION_MISMATCH' ? ' class="danger"' : '') + '>' + esc(o.region) + '</td>' +
        t(o.receivedAt, !isDispatch ? 'is-key' : '') +
        t(o.dispatchedAt, isDispatch ? 'is-key' : '') +
        t(o.pickedAt) +
        t(o.completedAt, 'is-key') +
        t(o.cancelledAt, 'danger') +
        durCell(dRcv, !isDispatch) +
        durCell(dDsp, isDispatch) +
        '<td>' + (o.accepted ? '<span class="mc-badge mc-badge--green">인정</span>' : '<span class="mc-badge mc-badge--red">미인정</span>') + '</td>' +
        '<td>' + reason + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="mc-orders">' + head + cond +
      '<table><thead><tr><th>#</th><th>주문번호</th><th>주문 제휴사</th><th>주문제휴사 주문아이디</th><th>상점명</th><th>지역</th>' +
      '<th class="' + (!isDispatch ? 'is-key' : '') + '">접수</th><th class="' + (isDispatch ? 'is-key' : '') + '">배정</th><th>픽업</th><th class="is-key">완료</th><th>취소</th>' +
      '<th class="num ' + (!isDispatch ? 'is-key' : '') + '">접수기준<span class="mc-th-sub">접수→완료</span></th>' +
      '<th class="num ' + (isDispatch ? 'is-key' : '') + '">배정기준<span class="mc-th-sub">배정→완료</span></th>' +
      '<th>인정</th><th>미인정 사유</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="mc-orders__foot"><span>미션 적용 기간 내 · 주문 제휴사 기준 수행 주문 · <b>인정은 완료건에 한함</b> (취소건은 미인정) · 강조 = 이 미션의 카운팅 기준(' + (isDispatch ? '배정' : '접수') + ' 후 ' + (m.limitMin || '-') + '분)</span><span>미인정 = 미션 조건 미충족으로 카운팅에서 제외된 주문 (카운팅은 레오엑스에서 수행)</span></div></div>';
  }
  /* 지원금 단계 스테퍼: 참여 → 1단계 → 2단계 … (라이더 앱과 동일한 표현)
     원 안: 인정건/필요건, 아래: 단계명 · 지원금. 도달한 단계는 채움 */
  function stepperHtml(tiers, accepted, reachedCount) {
    var nodes = [{ label: '참여', count: 0, reward: 0 }].concat(tiers.map(function (t, i) { return { label: (i + 1) + '단계', count: t.count, reward: t.reward }; }));
    var html = '<div class="mc-stepper">';
    nodes.forEach(function (n, i) {
      var done = accepted >= n.count;
      var isReached = n.count > 0 && n.count === reachedCount;
      if (i > 0) {
        var prev = nodes[i - 1].count, span = n.count - prev;
        var ratio = span > 0 ? Math.max(0, Math.min(1, (accepted - prev) / span)) : 1;
        html += '<div class="mc-stepper__line"><div class="mc-stepper__fill" style="width:' + Math.round(ratio * 100) + '%"></div></div>';
      }
      html += '<div class="mc-stepper__node ' + (done ? 'is-done' : '') + (isReached ? ' is-reached' : '') + '">' +
        '<div class="mc-stepper__circle">' + (i === 0 ? '1/1' : accepted + '/' + n.count) + '</div>' +
        '<div class="mc-stepper__label">' + esc(n.label) + '</div>' +
        '<div class="mc-stepper__reward">' + comma(n.reward) + '원' + (isReached ? ' <span class="mc-stepper__tag">지급</span>' : '') + '</div>' +
      '</div>';
    });
    html += '</div>';
    return '<div class="mc-stepper-wrap">' + html +
      '<div class="mc-stepper__note">인정건 <b>' + accepted + '</b> · ' +
      (reachedCount ? '<b>' + nodes.filter(function (n) { return n.count === reachedCount; })[0].label + '</b> 달성 · 최상위 1개 지급' : '미달성 · 1단계까지 ' + Math.max(0, tiers[0].count - accepted) + '건') +
      '</div></div>';
  }
  function condItem(label, html) {
    return '<span class="mc-cond"><span class="mc-cond__k">' + esc(label) + '</span><span class="mc-cond__v">' + html + '</span></span>';
  }

  /* ---------------------------------------------------------
     렌더 — 하단 합계 / 페이저
  --------------------------------------------------------- */
  function renderFoot(res) {
    var total = res.totalElements || 0;
    var t = res.totals || {};
    var sum;
    if (state.tab === 'mission') {
      sum = '총 <b>' + comma(total) + '</b>개 미션' +
        (t.cancelled ? ' · <span class="danger">지급취소 ' + comma(t.cancelled) + '건</span>' : '') +
        (t.unknown ? ' · <span class="danger">사유 불명 미인정 보유 ' + comma(t.unknown) + '건</span>' : '');
    } else if (state.tab === 'order') {
      sum = '주문 <b>' + comma(total) + '</b>건 · 인정 <b>' + comma(t.accepted) + '</b> · <span class="danger">미인정 ' + comma(t.rejected) + '</span>';
    } else {
      sum = '라이더 <b>' + comma(total) + '</b>명 · 참여 ' + comma(t.participations || total) + '건' + (t.multi ? ' <span class="muted">(복수 미션 참여 ' + comma(t.multi) + '명)</span>' : '') +
        ' · 달성 <b>' + comma(t.completed) + '</b> · 미달성 ' + comma(t.incomplete) +
        (t.cancelled ? ' · <span class="danger">취소 ' + comma(t.cancelled) + '</span>' : '') +
        (t.closed ? ' · 선착순 마감 ' + comma(t.closed) : '') +
        (t.withReject ? ' · <span class="warn">미인정 보유 ' + comma(t.withReject) + '명</span>' : '');
    }
    $foot.find('.mc-foot__sum').html(sum);

    var pages = Math.max(1, Math.ceil(total / state.size));
    var p = state.page, html = [];
    html.push('<button type="button" data-page="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + '>‹</button>');
    var start = Math.max(1, p - 2), end = Math.min(pages, start + 4); start = Math.max(1, end - 4);
    for (var i = start; i <= end; i++) html.push('<button type="button" data-page="' + i + '" class="' + (i === p ? 'is-active' : '') + '">' + i + '</button>');
    html.push('<button type="button" data-page="' + (p + 1) + '"' + (p >= pages ? ' disabled' : '') + '>›</button>');
    html.push('<select class="mc-select" id="mcSize" style="margin-left:8px;height:28px;font-size:12px">' +
      [20, 50, 100].map(function (n) { return '<option value="' + n + '"' + (n === state.size ? ' selected' : '') + '>' + n + '개</option>'; }).join('') + '</select>');
    $pager.html(html.join(''));
  }

  /* ---------------------------------------------------------
     로드
  --------------------------------------------------------- */
  function load(resetPage) {
    var f = readFilters();
    if (!validateFilters(f)) return;
    state.filters = f;
    if (resetPage) { state.page = 1; state.openRows = {}; }

    $kpis.addClass('is-loading');
    renderHead();
    renderSkeleton();

    API.summary(f).done(renderKpis);

    var sort = state.sort[state.tab];
    var req = state.tab === 'mission' ? API.byMission(f, state.page, state.size, sort)
            : state.tab === 'order' ? API.byOrder(f, state.page, state.size, sort)
            : API.byParticipant(f, state.page, state.size, sort);

    req.done(function (res) {
      state.counts[state.tab] = res.totalElements || 0;
      if (state.tab === 'mission') renderMissionRows(res.content || []);
      else if (state.tab === 'order') renderOrderRows(res.content || []);
      else { riderRowCache = {}; (res.content || []).forEach(function (r) { if (r.participations) riderRowCache[r.id] = r; }); renderParticipantRows(res.content || []); }
      renderFoot(res);
      updateTabCounts();
      $tbody.trigger('mc:rendered');
    }).fail(function () {
      $tbody.html('<tr><td colspan="' + colCount() + '"><div class="mc-empty"><i class="xi-error-o"></i>데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div></td></tr>');
    });

    // 다른 탭 카운트
    if (state.tab !== 'mission') API.byMission(f, 1, 1, state.sort.mission).done(function (r) { state.counts.mission = r.totalElements; updateTabCounts(); });
    if (state.tab !== 'participant') API.participantCount(f).done(function (r) { state.counts.participant = r.count; updateTabCounts(); });
    if (state.tab !== 'order') API.orderCount(f).done(function (r) { state.counts.order = r.count; updateTabCounts(); });
  }

  function updateTabCounts() {
    $tabs.find('[data-tab="mission"] .mc-tab__count').text(comma(state.counts.mission));
    $tabs.find('[data-tab="participant"] .mc-tab__count').text(comma(state.counts.participant));
    $tabs.find('[data-tab="order"] .mc-tab__count').text(comma(state.counts.order));
  }

  function switchTab(tab) {
    if (state.tab === tab) { renderMissionChip(); load(true); return; }
    state.tab = tab;
    state.page = 1;
    state.openRows = {};
    $tabs.find('.mc-tab').removeClass('is-active').filter('[data-tab="' + tab + '"]').addClass('is-active');
    $root.find('.js-participant-only').toggle(tab === 'participant');
    $root.find('.js-order-only').toggle(tab === 'order');
    $root.find('.js-mission-only').toggle(tab === 'mission');
    renderMissionChip();
    load(true);
  }

  /* ---------------------------------------------------------
     지급 취소
  --------------------------------------------------------- */
  function confirmCancel(pid) {
    var $tr = $tbody.find('tr[data-id="' + pid + '"]');
    var rider = $tr.find('td').eq(1).find('.strong').text() + ' ' + $tr.find('td').eq(1).find('.mc-rider__id').text();
    var mission = $tr.find('td').eq(3).contents().first().text();
    var reward = $tr.find('td').eq(8).text();

    Swal.fire({
      title: '이 라이더의 미션을 취소할까요?',
      html: '<div class="mc-cancel-info"><b>' + esc(rider) + '</b><br>' + esc(mission) + '<br>지급금액 <b>' + esc(reward) + '원</b> 이 회수됩니다.</div>' +
            '<textarea class="mc-textarea" id="mcCancelReason" placeholder="취소 사유를 입력해주세요 (필수)"></textarea>',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: '취소 처리',
      cancelButtonText: '닫기',
      confirmButtonColor: '#d64545',
      focusConfirm: false,
      preConfirm: function () {
        var v = $.trim($('#mcCancelReason').val());
        if (!v) { Swal.showValidationMessage('취소 사유는 필수입니다.'); return false; }
        return v;
      }
    }).then(function (r) {
      if (!r.isConfirmed) return;
      API.cancel(pid, r.value).done(function () {
        toast('success', '지급이 취소되었습니다.');
        load(false);
      }).fail(function () {
        Swal.fire({ icon: 'error', title: '취소 처리에 실패했습니다.' });
      });
    });
  }

  /* ---------------------------------------------------------
     미션 상세 모달 — 기존 어드민 「미션 상세」 화면과 동일 레이아웃(읽기 전용)
  --------------------------------------------------------- */
  function openMissionDetail(missionId) {
    closeMissionDetail();
    var $modal = $('<div class="mc-modal"><div class="mc-modal__backdrop"></div>' +
      '<div class="mc-modal__panel" role="dialog" aria-modal="true">' +
        '<button type="button" class="mc-modal__close" aria-label="닫기"><i class="xi-close"></i></button>' +
        '<div class="mc-modal__body"><div class="mc-empty">불러오는 중…</div></div>' +
      '</div></div>');
    $('body').append($modal).addClass('mc-modal-open');
    API.missionDetail(missionId).done(function (m) {
      if (!m) { $modal.find('.mc-modal__body').html('<div class="mc-empty">미션 정보를 찾을 수 없습니다.</div>'); return; }
      $modal.find('.mc-modal__body').html(missionDetailHtml(m));
    });
  }
  function closeMissionDetail() {
    $('.mc-modal').remove();
    $('body').removeClass('mc-modal-open');
  }

  function radio(options, value) {
    return '<div class="mc-radios">' + options.map(function (o) {
      return '<label class="mc-radio ' + (o.v === value ? 'is-on' : '') + '"><span class="mc-radio__dot"></span>' + esc(o.t) +
        (o.help ? ' <i class="xi-help mc-help" title="' + esc(o.help) + '"></i>' : '') + '</label>';
    }).join('') + '</div>';
  }
  function checks(options) {
    return '<div class="mc-radios">' + options.map(function (o) {
      return '<label class="mc-checkbox ' + (o.on ? 'is-on' : '') + '"><span class="mc-checkbox__box">' + (o.on ? '<i class="xi-check"></i>' : '') + '</span>' + esc(o.t) + '</label>';
    }).join('') + '</div>';
  }
  function ro(value, cls) { return '<div class="mc-ro ' + (cls || '') + '">' + (value == null || value === '' ? '&nbsp;' : value) + '</div>'; }
  function row(label, html, required) {
    return '<div class="mc-form__row"><div class="mc-form__label">' + esc(label) + (required ? ' <em>*</em>' : '') + '</div><div class="mc-form__value">' + html + '</div></div>';
  }
  function fmtShort(dt) { var d = new Date(dt); return String(d.getFullYear()).slice(2) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + fmtTime(d); }

  function missionDetailHtml(m) {
    var regionList = (MOCK.regionById(m.regionId).list || [m.regionName]);
    var regionChips = '<div class="mc-chips">' + regionList.map(function (n) { return '<span class="mc-chip-item">' + esc(n) + '</span>'; }).join('') + '</div>';
    var brand = (m.agencyNames || []).join(', ');
    var period = m.type === 'DISPATCH' ? '배차 후' : '접수 후';

    var html = '<div class="mc-modal__head"><h3>미션 상세</h3><span class="mc-badge mc-badge--outline">본사미션</span>' + statusBadge(m.status, m.progress) + '</div>' +
      '<div class="mc-form">' +
        row('브랜드', ro(esc(brand), 'is-plain')) +
        row('지역 선택', regionChips, true) +
        row('화주사', ro(esc((m.partnerNames || []).join(', ')), 'is-plain')) +
        row('미션 제목', ro(esc(m.title)), true) +
        row('미션 내용', ro(esc(m.description || ''), 'is-textarea')) +
        row('미션 타입', radio([{ v: 'REPEAT', t: '반복', help: '매일 같은 조건으로 반복' }, { v: 'PERIOD', t: '기간한정', help: '지정한 기간 동안만 진행' }], m.missionKind), true) +
        (m.missionKind === 'REPEAT'
          ? '<div class="mc-form__section"><div class="mc-form__section-title">반복 미션</div>' +
              row('반복 기준', radio([{ v: 'DAILY', t: '일일' }, { v: 'WEEKLY', t: '주간' }, { v: 'MONTHLY', t: '월간' }, { v: 'WEEKDAY', t: '요일' }], m.repeatBasis || 'DAILY'), true) +
              (m.repeatBasis === 'WEEKDAY' ? row('요일', checks([1,2,3,4,5,6,0].map(function (w) { return { t: WEEKDAY_KO[w], on: (m.weekdays || []).indexOf(w) >= 0 }; }))) : '') +
            '</div>'
          : '') +

        '<div class="mc-form__section"><div class="mc-form__section-title">' + (m.missionKind === 'REPEAT' ? '진행 기간 · 시간' : '기간 한정 미션') + '</div>' +
          row('기간 선택', '<div class="mc-range-ro">' + ro(fmtShort(m.periodStart)) + '<span>~</span>' + ro(fmtShort(m.periodEnd)) + '</div><div class="mc-form__hint">※ 최대 한 달까지 선택 가능합니다.</div>', true) +
          row('이벤트 진행', radio([{ v: true, t: '매일 초기화' }, { v: false, t: '초기화 없음' }], m.dailyReset), true) +
          row('기준 시간', radio([{ v: 'ASSIGNED', t: '배정한 시간' }, { v: 'COMPLETED', t: '완료한 시간' }], m.baseTime), true) +
          row('미션 진행 시간', '<div class="mc-range-ro"><div class="mc-ro">' + esc(m.progressTime[0]) + ' &nbsp;~&nbsp; ' + esc(m.progressTime[1]) + '</div></div>', true) +
          row('공유콜 포함여부', radio([{ v: 'ALL', t: '자사+공유포함' }, { v: 'OWN', t: '자사만' }, { v: 'SHARED', t: '공유만' }], m.sharedCall), true) +
        '</div>' +

        row('미션 카운팅 조건', checks([{ t: '거리', on: m.countingCond.distance }, { t: '권역', on: m.countingCond.zone }])) +
        row('선착순 지급', radio([{ v: true, t: '사용' }, { v: false, t: '미사용' }], m.firstCome), true) +
        row('미션 완료 조건', checks([{ t: '출퇴근', on: m.completeCond.commute }, { t: period + ' 완료 시간', on: m.completeCond.receiptTime }, { t: '가입 후 처음 콜 완료시에만 보상', on: m.completeCond.firstCall }]), true) +

        '<div class="mc-form__section"><div class="mc-form__section-title">미션 완료 조건</div>' +
          row(period + ' 완료 시간', m.limitMin
            ? '<div class="mc-ro mc-ro--unit"><b>' + m.limitMin + '</b><span>분 이내에 완료 시 카운팅</span></div>'
            : ro('제한 없음', 'is-plain')) +
        '</div>' +

        row('미션 보상', radio([{ v: 'CASH', t: '캐시' }], m.rewardType), true) +
        '<div class="mc-form__section"><div class="mc-form__section-title">미션 보상</div>' +
          '<div class="mc-tiers">' + (m.tiers || []).map(function (t) {
            return '<div class="mc-tiers__row">' +
              '<div class="mc-ro mc-ro--unit"><b>' + t.count + '</b><span>건 완료</span></div>' +
              '<div class="mc-ro mc-ro--unit"><b>' + (t.zoneCount || 0) + '</b><span>건 권역 완료</span></div>' +
              '<div class="mc-ro mc-ro--unit"><b>' + comma(t.reward) + '</b><span>원 지급</span></div>' +
            '</div>';
          }).join('') + '</div>' +
          '<div class="mc-form__hint">달성한 최상위 단계 1개의 금액만 지급됩니다.</div>' +
        '</div>' +

        '<div class="mc-form__section mc-form__section--result"><div class="mc-form__section-title">수행 결과</div>' +
          '<div class="mc-result">' +
            '<div><span>참여인원</span><b>' + comma(m.participants) + '</b>명</div>' +
            '<div><span>수행건</span><b>' + comma(m.performed) + '</b>건</div>' +
            '<div><span>인정건</span><b>' + comma(m.accepted) + '</b>건</div>' +
            '<div><span>달성인원</span><b>' + comma(m.completed) + '</b>명</div>' +
            '<div><span>지급금액</span><b>' + comma(m.paid) + '</b>원</div>' +
            (m.cancelled ? '<div class="is-danger"><span>지급취소</span><b>' + comma(m.cancelled) + '</b>건</div>' : '') +
          '</div>' +
          (m.status === 'BEFORE' ? '<div class="mc-form__hint">시작 전 미션 — 수행 결과가 없습니다.</div>' : '<button type="button" class="mc-btn mc-btn--green mc-btn--sm js-mission-detail" data-id="' + m.id + '" data-title="' + esc(m.title) + '">참여자 보기</button>') +
        '</div>' +
      '</div>';
    return html;
  }

  /* ---------------------------------------------------------
     엑셀
  --------------------------------------------------------- */
  var DATASET_TEXT = { mission: '미션별', participant: '참여자별', order: '주문별' };

  function toggleDlPop() { if ($('#mcDlPop').prop('hidden')) openDlPop(); else closeDlPop(); }
  function openDlPop() {
    // 현재 화면 조건을 기본값으로
    $('#dlDataset').val(state.tab);
    $('#dlAgency').val(state.filters.agencyId || '');
    $('#dlFrom').val(state.filters.from || $('#mcFrom').val());
    $('#dlTo').val(state.filters.to || $('#mcTo').val());
    $('#mcDlPop').prop('hidden', false);
  }
  function closeDlPop() { $('#mcDlPop').prop('hidden', true); }

  function exportExcel() {
    var f = $.extend({}, state.filters, {
      from: $('#dlFrom').val(), to: $('#dlTo').val(),
      agencyId: $('#dlAgency').val() || '',
      dateBasis: 'operation'
    });
    var dataset = $('#dlDataset').val() || state.tab;
    var format = $('#dlFormat').val() || 'xlsx';
    if (!validateFilters(f)) return;
    if (!CONFIG.EXPORT_CLIENT) { window.location.href = API.exportUrl($.extend({}, f, { format: format }), dataset); return; }
    if (!window.XLSX) { Swal.fire({ icon: 'error', title: '엑셀 라이브러리를 불러오지 못했습니다.' }); return; }

    var $btn = $('#dlGo').prop('disabled', true);
    state.exporting = true;
    var fileName = '미션_' + DATASET_TEXT[dataset] + '_' + f.from + '_' + f.to + (format === 'txt' ? '.txt' : '.xlsx');   // 예: 미션_참여자별_2026-09-04_2026-09-17.xlsx
    buildWorkbook(f, dataset).done(function (r) {
      if (format === 'txt') {
        // 텍스트(탭 구분): 첫 시트만
        var ws = r.wb.Sheets[r.wb.SheetNames[0]];
        var txt = XLSX.utils.sheet_to_csv(ws, { FS: '\t' });
        var blob = new Blob(['\ufeff' + txt], { type: 'text/plain;charset=utf-8' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      } else {
        XLSX.writeFile(r.wb, fileName);
      }
      toast('success', DATASET_TEXT[dataset] + ' 다운로드 · ' + r.summary);
      closeDlPop();
    }).fail(function () {
      Swal.fire({ icon: 'error', title: '파일 생성에 실패했습니다.' });
    }).always(function () { $btn.prop('disabled', false); state.exporting = false; });
  }

  /* 현재 필터 전체(페이지 무관)로 워크북 생성 */
  function buildWorkbook(f, tab) {
    var d = $.Deferred();
    var sort = state.sort[tab] || state.sort.participant;
    var BIG = 100000;
    var wb = XLSX.utils.book_new();
    var fmtDT = function (v) { return v ? fmtDateTime(v) : ''; };
    var fmtT = function (v) { return v ? fmtTime(new Date(v)) : ''; };

    // 조건 시트 (공통)
    var cond = [['항목', '값'],
      ['데이터', DATASET_TEXT[tab] || tab],
      ['기준일', f.dateBasis === 'paid' ? '지급일' : '운영기준일 (미션 적용 기간)'],
      ['조회 기간', f.from + ' ~ ' + f.to],
      ['미션 상태', $('#mcStatus option:selected').text() || '전체'],
      ['주문 제휴사', (f.partnerIds && f.partnerIds.length) ? f.partnerIds.map(function (id) { return MOCK.partnerById(id).name; }).join(', ') : '전체'],
      ['배달대행사', f.agencyId ? MOCK.agencyById(f.agencyId).name : '전체'],
      ['미션 타입', f.kind ? KIND_LABEL[f.kind] : '전체'],
      ['완료카운팅 조건', $('#mcType option:selected').text() || '전체'],
      ['검색', f.keyword ? ($('#mcKeywordType option:selected').text() + ': ' + f.keyword) : '-'],
      ['생성 시각', fmtDateTime(new Date())],
      ['카운팅 주체', '레오엑스 (참여/인정 판정 로그 기준)']];

    if (tab === 'mission') {
      API.byMission(f, 1, BIG, sort).done(function (res) {
        var rows = res.content || [];
        var aoa = [['미션명', '상태', '미션 타입', '배달대행사', '완료카운팅 조건', '부가 조건', '주문 제휴사', '적용 지역', '적용 시작', '적용 종료', '지급 단계',
                    '수행건', '인정건', '완료율(%)', '참여인원', '달성인원', '지급금액', '지급취소(건)']];
        rows.forEach(function (r) {
          aoa.push([r.title, STATUS_LABEL[r.status].text, r.kindLabel + (r.kindSub ? ' ' + r.kindSub : ''), r.agencyLabel, countingText(r), r.condText || '',
            (r.partnerNames || []).join(', '), r.regionName, fmtDT(r.periodStart), fmtDT(r.periodEnd), tiersLabel(r.tiers),
            r.status === 'BEFORE' ? '' : r.performed, r.status === 'BEFORE' ? '' : r.accepted, r.completeRate == null ? '' : r.completeRate,
            r.status === 'BEFORE' ? '' : r.participants, r.status === 'BEFORE' ? '' : r.completed, r.status === 'BEFORE' ? '' : r.paid, r.cancelled || 0]);
        });
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [34, 8, 12, 12, 14, 24, 22, 20, 17, 17, 40, 8, 8, 9, 9, 9, 11, 10].map(function (w) { return { wch: w }; });
        XLSX.utils.book_append_sheet(wb, ws, '미션별');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cond), '조회조건');
        d.resolve({ wb: wb, summary: '미션 ' + comma(rows.length) + '건' });
      }).fail(d.reject);
      return d.promise();
    }

    if (tab === 'order') {
      API.byOrder(f, 1, BIG, state.sort.order).done(function (res) {
        var rows = res.content || [];
        var fT = function (v) { return v ? fmtDateTime(v) : ''; };
        var aoa = [['미션명', '미션 상태', '완료카운팅 조건', '주문번호', '주문제휴사 주문아이디', '주문 제휴사', '상점명', '지역', '라이더 코드', '라이더명', '배달대행사', '소속 허브', '수행허브코드',
                    '접수', '배정', '픽업', '완료', '취소', '접수기준(분)', '배정기준(분)', '인정', '미인정 사유', '초과(분)']];
        rows.forEach(function (o) {
          aoa.push([o.missionTitle, STATUS_LABEL[o.missionStatus].text, o.limitMin ? TYPE_LABEL[o.missionType] + ' ' + o.limitMin + '분' : '없음',
            o.orderNo, o.orderExtId || '', o.partner, o.storeName || '', o.region, o.riderId, o.riderName, o.agencyName, o.hubName || '', o.hubCode || '', fT(o.receivedAt), fT(o.dispatchedAt), fT(o.pickedAt), fT(o.completedAt), fT(o.cancelledAt),
            o.dRcv == null ? '' : o.dRcv, o.dDsp == null ? '' : o.dDsp, o.accepted ? '인정' : '미인정', o.accepted ? '' : (REJECT[o.rejectReason] || o.rejectReason || ''), o.over || '']);
        });
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [30, 8, 14, 10, 22, 12, 18, 18, 20, 9, 11, 14, 20, 17, 17, 17, 17, 17, 11, 11, 7, 22, 8].map(function (w) { return { wch: w }; });
        XLSX.utils.book_append_sheet(wb, ws, '주문별');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cond), '조회조건');
        d.resolve({ wb: wb, summary: '주문 ' + comma(rows.length) + '건' });
      }).fail(d.reject);
      return d.promise();
    }

    // 참여자별: 참여자 시트 + 주문 단위 시트
    API.byParticipant(f, 1, BIG, sort).done(function (res) {
      // 화면은 라이더 단위로 묶여 있지만 엑셀은 참여(라이더×미션) 단위 → 묶인 행을 다시 펼친다
      var rows = [];
      (res.content || []).forEach(function (r) { if (r.participations) rows = rows.concat(r.participations); else rows.push(r); });
      var riderCount = (res.content || []).length;
      var aoa = [['라이더 코드', '라이더명', '배달대행사', '소속 허브', '수행허브코드', '미션명', '미션 상태', '적용 지역', '수행건', '인정건', '미인정건', '달성 단계', '지급금액', '지급시간',
                  '달성', '지급', '지급 예정', '취소 시각', '취소 처리자', '취소 사유']];
      rows.forEach(function (p) {
        var pay = p.tierCount ? (PAY_LABEL[p.status] ? PAY_LABEL[p.status].text : '') : '';
        aoa.push([p.riderId, p.riderName, p.agencyName, p.hubName || '', p.hubCode || '', p.missionTitle, STATUS_LABEL[p.missionStatus].text, p.regionName,
          p.performed, p.accepted, p.rejected, p.tierCount ? p.tierCount + '건' : '미달', p.tierCount ? p.reward : '', fmtDT(p.paidAt),
          p.tierCount ? '달성' : (p.missionStatus === 'RUNNING' ? '진행중' : '미달성'), pay, p.status === 'PENDING' ? fmtDT(p.payDueAt) : '',
          fmtDT(p.cancelledAt), p.cancelledBy || '', p.cancelReason || '']);
      });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [20, 9, 11, 14, 20, 34, 9, 20, 7, 7, 8, 9, 10, 17, 7, 9, 17, 17, 10, 24].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, ws, '참여자별');

      // 주문 단위 (목데이터는 동기 생성 → 순차 조회)
      var oa = [['라이더 코드', '라이더명', '소속 허브', '수행허브코드', '미션명', '완료카운팅 조건', '주문번호', '주문 제휴사', '주문제휴사 주문아이디', '지역',
                 '접수', '배정', '픽업', '완료', '취소', '접수기준(분)', '배정기준(분)', '인정', '미인정 사유', '초과(분)']];
      var count = 0, i = 0;
      function mins(a, b) { return (a && b) ? Math.round((new Date(b) - new Date(a)) / 60000) : ''; }
      function next() {
        if (i >= rows.length || count >= CONFIG.EXPORT_MAX_ORDERS) return finish();
        var p = rows[i++];
        API.orders(p.missionId, p.id).done(function (o) {
          var m = o.mission || {};
          var isDispatch = m.type === 'DISPATCH';
          (o.content || []).forEach(function (x) {
            var dR = mins(x.receivedAt, x.completedAt), dD = mins(x.dispatchedAt, x.completedAt);
            var key = isDispatch ? dD : dR;
            var over = (m.limitMin && key !== '' && key > m.limitMin) ? key - m.limitMin : '';
            oa.push([p.riderId, p.riderName, p.hubName || '', p.hubCode || '', p.missionTitle, m.limitMin ? TYPE_LABEL[m.type] + ' ' + m.limitMin + '분' : '없음',
              x.orderNo, x.partner, x.orderExtId || '', x.region,
              fmtT(x.receivedAt), fmtT(x.dispatchedAt), fmtT(x.pickedAt), fmtT(x.completedAt), fmtT(x.cancelledAt),
              dR, dD, x.accepted ? '인정' : '미인정', x.accepted ? '' : (REJECT[x.rejectReason] || x.rejectReason || ''), over]);
            count++;
          });
          // 목데이터 지연(260ms)을 우회: 다음 건 즉시
          next();
        }).fail(finish);
      }
      function finish() {
        var wso = XLSX.utils.aoa_to_sheet(oa);
        wso['!cols'] = [20, 9, 14, 20, 34, 14, 10, 12, 22, 18, 7, 7, 7, 7, 7, 11, 11, 7, 22, 8].map(function (w) { return { wch: w }; });
        XLSX.utils.book_append_sheet(wb, wso, '주문단위');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cond), '조회조건');
        d.resolve({ wb: wb, summary: '라이더 ' + comma(riderCount) + '명 · 참여 ' + comma(rows.length) + '건 · 주문 ' + comma(count) + '건' });
      }
      next();
    }).fail(d.reject);
    return d.promise();
  }

  /* ---------------------------------------------------------
     기간 프리셋
  --------------------------------------------------------- */
  function setRange(days) {
    // days > 0: 과거 N일 (오늘 포함) / 'upcoming': 오늘~향후 7일 / 'around': 최근 7일 + 향후 7일 (기본)
    var today = new Date(), from, to;
    if (days === 'upcoming') { from = today; to = addDays(today, 7); }
    else if (days === 'around') { from = addDays(today, -6); to = addDays(today, 7); }
    else { from = addDays(today, -(days - 1)); to = today; }
    $('#mcFrom').val(fmtDate(from));
    $('#mcTo').val(fmtDate(to));
    $('.mc-quick button').removeClass('is-active').filter('[data-days="' + days + '"]').addClass('is-active');
  }

  /* ---------------------------------------------------------
     초기화
  --------------------------------------------------------- */
  function initControls() {
    // 옵션 목록 (실서비스: 고릴라 동기화 마스터에서 내려주는 목록으로 대체)
    var $partner = $('#mcPartner'), $agency = $('#mcAgency');
    MOCK.partners.forEach(function (b) { $partner.append('<option value="' + b.id + '">' + esc(b.name) + '</option>'); });
    MOCK.agencies.forEach(function (a) { $agency.append('<option value="' + a.id + '">' + esc(a.name) + '</option>'); });

    if ($.fn.select2) {
      $root.find('.mc-select2').not('.mc-select2--multi').select2({ minimumResultsForSearch: 6, width: 'resolve' });
      // 주문 제휴사: 체크박스형 드롭다운. '전체' = 선택 없음
      var $partnerSel = $root.find('.mc-select2--multi');
      function partnerEmpty() { return !($partnerSel.val() || []).filter(function (v) { return v !== 'ALL'; }).length; }
      // 선택 요약 텍스트: 전체 / 요기배달, 땡배달 / 요기배달 외 2개  (칩 대신 한 줄 요약)
      function partnerSummary() {
        var names = ($partnerSel.val() || []).filter(function (v) { return v !== 'ALL'; })
          .map(function (v) { return $partnerSel.find('option[value="' + v + '"]').text(); });
        if (!names.length) return '전체';
        return names.length <= 2 ? names.join(', ') : names[0] + ' 외 ' + (names.length - 1) + '개';
      }
      function syncAllOption() {
        // 드롭다운이 열려 있으면 '전체' 항목의 체크 상태를 현재 선택에 맞춤
        $('.mc-dd .select2-results__option').each(function () {
          if ($(this).find('.mc-dd-label').text() === '전체') $(this).toggleClass('select2-results__option--selected', partnerEmpty()).attr('aria-selected', partnerEmpty() ? 'true' : 'false');
        });
      }
      $partnerSel.select2({
        width: 'resolve', closeOnSelect: false, placeholder: '', dropdownCssClass: 'mc-dd',
        templateResult: function (d) {
          if (!d.id) return d.text;
          var on = d.id === 'ALL' ? partnerEmpty() : !!d.selected;
          return $('<span class="mc-dd-item"><span class="mc-dd-check"></span><span class="mc-dd-label">' + esc(d.text) + '</span></span>').closest('span').attr('data-on', on ? 1 : 0);
        }
      })
      .on('select2:select', function (e) {
        var id = e.params.data.id;
        if (id === 'ALL') { $(this).val(null).trigger('change'); }                         // 전체 클릭 → 개별 선택 해제
        else { var v = ($(this).val() || []).filter(function (x) { return x !== 'ALL'; }); $(this).val(v).trigger('change'); }
        syncAllOption();
      })
      .on('select2:unselect', function () { setTimeout(syncAllOption, 0); })
      .on('select2:open', function () { setTimeout(syncAllOption, 0); })
      .on('change.mcEmpty', function () {
        // 칩 대신 요약 텍스트 (CSS ::before 가 data-summary 를 표시)
        $(this).next('.select2-container').toggleClass('is-empty', partnerEmpty())
          .find('.select2-selection__rendered').attr('data-summary', partnerSummary());
      }).trigger('change.mcEmpty');
    }
    if ($.fn.datepicker) {
      $('.mc-input--date').datepicker({
        dateFormat: 'yy-mm-dd',
        monthNames: ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'],
        monthNamesShort: ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'],
        dayNamesMin: ['일','월','화','수','목','금','토'],
        showMonthAfterYear: true, yearSuffix: '년',
        onSelect: function () { $('.mc-quick button').removeClass('is-active'); }
      });
    }
    setRange('around');
    $root.find('.js-participant-only, .js-order-only').hide();
  }

  function bindEvents() {
    // 탭 헤더 직접 클릭 = 전체 보기 → 미션 고정 해제
    $tabs.on('click', '.mc-tab', function () { state.mission = null; switchTab($(this).data('tab')); });
    $('#mcMissionChip').on('click', '.js-chip-clear', function () { state.mission = null; renderMissionChip(); load(true); });

    $('#mcSearchBtn').on('click', function () { load(true); });
    $('#mcRefreshBtn').on('click', function () { $(this).addClass('is-spin'); load(false); setTimeout(function () { $('#mcRefreshBtn').removeClass('is-spin'); }, 600); });
    $('#mcKeyword').on('keydown', function (e) { if (e.key === 'Enter') load(true); });
    // 셀렉트/체크 필터는 변경 즉시 조회 (검색어만 '조회' 버튼/Enter)
    $('#mcResult, #mcRejectOnly, #mcStatus, #mcAgency, #mcType, #mcAccepted, #mcKind').on('change', function () { load(true); });
    $('#mcPartner').on('change.mcApply', function () { load(true); });
    $('#mcKeywordType').on('change', function () {
      var ph = { ALL: '미션명 · 지역 · 화주사 · 라이더 · 주문번호 · 주문아이디', MISSION: '미션명 입력', REGION: '지역 입력 (예: 강남구, 천안)', PARTNER: '화주사 입력 (예: 올리브영)', RIDER_CODE: '라이더 코드 입력 (예: PKQU8LHP30I4UGQUU)', RIDER_NAME: '라이더 이름 입력', ORDER_NO: '주문번호 입력 (예: 8645290)', ORDER_EXT: '주문제휴사 주문아이디 입력 (예: 341978877499812342)' };
      $('#mcKeyword').attr('placeholder', ph[$(this).val()] || '').focus();
    });
    $('.mc-quick').on('click', 'button', function () { var d = $(this).data('days'); setRange(isNaN(Number(d)) ? d : Number(d)); load(true); });
    // 다운로드 조건 팝업
    $('#mcExportBtn').on('click', function (e) { e.stopPropagation(); toggleDlPop(); });
    $('#dlClose').on('click', closeDlPop);
    $('#dlGo').on('click', exportExcel);
    $(document).on('click.mcDl', function (e) { if (!$(e.target).closest('.mc-dl, .ui-datepicker').length) closeDlPop(); });
    if ($.fn.datepicker) $('#dlFrom, #dlTo').datepicker({ dateFormat: 'yy-mm-dd', monthNames: ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'], monthNamesShort: ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'], dayNamesMin: ['일','월','화','수','목','금','토'], showMonthAfterYear: true, yearSuffix: '년' });
    $('#mcResetBtn').on('click', function () {
      $('#mcAgency, #mcType, #mcResult, #mcStatus, #mcAccepted, #mcKind').val('');
      $('#mcPartner').val(null).trigger('change.select2');
      $('#mcKeywordType').val('ALL').trigger('change');
      $('#mcKeyword').val(''); $('#mcRejectOnly').prop('checked', false);
      state.mission = null; renderMissionChip();
      setRange('around'); load(true);
    });

    // 정렬
    $thead.on('click', 'th[data-sort]', function () {
      var key = $(this).data('sort'), s = state.sort[state.tab];
      if (s.field === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.field = key; s.dir = /title|Name/i.test(key) ? 'asc' : 'desc'; }
      state.page = 1; load(false);
    });

    // 페이저
    $pager.on('click', 'button[data-page]', function () {
      if ($(this).is('[disabled]')) return;
      state.page = Number($(this).data('page')); load(false);
      $('html, body').animate({ scrollTop: $root.offset().top - 20 }, 150);
    });
    $pager.on('change', '#mcSize', function () { state.size = Number($(this).val()); state.page = 1; load(false); });

    // 미션별 → 참여자 보기 (missionId 가 필터에 실려 참여자·KPI 모두 해당 미션 기준)
    $tbody.on('click', '.js-mission-detail', function (e) {
      e.stopPropagation();
      state.mission = { id: Number($(this).data('id')), title: $(this).data('title') };
      switchTab('participant');
    });

    // 참여자 행 펼침: 단일 참여 → 주문 / 여러 미션 참여 → 참여 미션 목록(중간 단계)
    $tbody.on('click', 'tr.is-clickable', function (e) {
      if ($(e.target).closest('button, a').length && !$(e.target).closest('.js-toggle-orders').length) return;
      var $tr = $(this);
      if ($tr.hasClass('is-multi')) { if ($tr.hasClass('is-open')) closeRider($tr); else openRider($tr); return; }
      if ($tr.hasClass('is-open')) closeOrders($tr); else openOrders($tr);
    });
    // 하위 미션 행 → 주문 내역 (선택한 미션 아래로)
    $tbody.on('click', 'tr.js-sub-row', function (e) {
      e.stopPropagation();
      if ($(e.target).closest('button, a').length && !$(e.target).closest('.js-toggle-orders').length) return;
      toggleSubOrders($(this));
    });
    $tbody.on('click', 'tr.mc-sub__orders, tr.mc-expand', function (e) { e.stopPropagation(); });

    // 관리 메뉴 (⋮) → 미션 취소
    $tbody.on('click', '.js-kebab', function (e) {
      e.stopPropagation();
      var $b = $(this), id = Number($b.data('id'));
      if ($('.mc-menu').data('for') === id) { closeMenu(); return; }
      closeMenu();
      var r = this.getBoundingClientRect();
      var $m = $('<div class="mc-menu" role="menu">' +
        '<button type="button" class="mc-menu__item is-danger js-cancel" data-id="' + id + '"><i class="xi-close-circle-o"></i> 미션 취소<small>지급된 금액 회수</small></button>' +
      '</div>').data('for', id);
      $('body').append($m);
      // 80% 배율 보정 — 브라우저마다 getBoundingClientRect 가 시각 px(표준) 또는 zoom 좌표계(구형)를 돌려주므로 런타임에 판별
      var page = document.querySelector('.mc-page');
      var z = parseFloat(getComputedStyle(page).zoom) || 1;
      var pr = page.getBoundingClientRect();
      var rectIsVisual = Math.abs(pr.width - page.offsetWidth * z) < Math.abs(pr.width - page.offsetWidth);
      var k = rectIsVisual ? z : 1;
      $m.css({ top: r.bottom / k + window.scrollY / z + 4, left: r.right / k + window.scrollX / z - $m.outerWidth() });
      $b.addClass('is-open');
    });
    function closeMenu() { $('.mc-menu').remove(); $('.js-kebab.is-open').removeClass('is-open'); }
    $(document).on('click.mcMenu', function (e) { if (!$(e.target).closest('.mc-menu, .js-kebab').length) closeMenu(); });
    $(document).on('keydown.mcMenu', function (e) { if (e.key === 'Escape') closeMenu(); });
    $(window).on('scroll.mcMenu', closeMenu);

    // 미션 취소 (메뉴 항목)
    $(document).on('click', '.mc-menu .js-cancel', function (e) { e.stopPropagation(); var id = Number($(this).data('id')); closeMenu(); confirmCancel(id); });

    // 미션명 클릭 → 미션 상세 모달
    $tbody.on('click', '.js-mission-open', function (e) {
      e.preventDefault(); e.stopPropagation();
      openMissionDetail(Number($(this).data('id')));
    });
    $(document).on('click', '.mc-modal__close, .mc-modal__backdrop', closeMissionDetail);
    $(document).on('click', '.mc-modal .js-mission-detail', function () {
      state.mission = { id: Number($(this).data('id')), title: $(this).data('title') };
      closeMissionDetail();
      switchTab('participant');
    });
    $(document).on('keydown.mcModal', function (e) { if (e.key === 'Escape') closeMissionDetail(); });

    // 빈 상태 → 기간 넓히기
    $tbody.on('click', '#mcWiden', function () { setRange(30); load(true); });
  }

  $(function () {
    $root = $('#missionList');
    if (!$root.length) return;
    $kpis = $root.find('.mc-kpi');
    $thead = $root.find('#mcThead');
    $tbody = $root.find('#mcTbody');
    $foot = $root.find('.mc-foot');
    $pager = $root.find('.mc-pager');
    $tabs = $root.find('.mc-tabs');

    initControls();
    bindEvents();

    // 딥링크: #tab=participant&missionId=123  (미션 내역 카드 → 참여자 바로 열기 등)
    var hash = {};
    (window.location.hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='); if (p[0]) hash[p[0]] = decodeURIComponent(p[1] || '');
    });
    if (hash.missionId) {
      var mm = CONFIG.USE_MOCK ? MOCK.missionById(Number(hash.missionId)) : null;
      state.mission = { id: Number(hash.missionId), title: mm ? mm.title : '미션 #' + hash.missionId };
    }
    if (hash.status) $('#mcStatus').val(hash.status);
    if (hash.kind) $('#mcKind').val(hash.kind);
    if (hash.qa === 'kebab') $tbody.one('mc:rendered', function () { setTimeout(function () { $tbody.find('.js-kebab').first().trigger('click'); }, 50); });   // QA: 메뉴 열어두기
    if (hash.qa === 'dlpop') $tbody.one('mc:rendered', function () { setTimeout(openDlPop, 50); });   // QA: 다운로드 팝업 열어두기
    if (hash.qa === 'hub') $tbody.one('mc:rendered', function () { var out = {}; MOCK.participants.forEach(function (p) { out[p.agencyId + ':' + p.hubName] = 1; }); $('body').append('<pre id="mcDebug">' + Object.keys(out).sort().join('<br>') + '</pre>'); });   // QA: 소속 허브 값 목록
    if (hash.qa === 'export') $tbody.one('mc:rendered', function () {          // QA용: 워크북 생성 결과 확인
      state.exporting = true;
      buildWorkbook($.extend({}, state.filters, { dateBasis: hash.basis || 'operation' }), hash.dataset || state.tab).done(function (r) {
        var out = r.wb.SheetNames.map(function (n) { var ws = r.wb.Sheets[n]; var ref = XLSX.utils.decode_range(ws['!ref']); return n + ': ' + (ref.e.r) + ' rows x ' + (ref.e.c + 1) + ' cols'; });
        $('body').append('<pre id="mcDebug">' + out.join('\n') + '\n' + r.summary + '</pre>');
        state.exporting = false;
      });
    });
    if (hash.detail) $tbody.one('mc:rendered', function () { openMissionDetail(Number(hash.detail)); });
    if (hash.pick || hash.preview === 'partnerdd') $tbody.one('mc:rendered', function () {   // QA용: 제휴사 선택/드롭다운 열기
      if (hash.pick) $('#mcPartner').val(String(hash.pick).split(',')).trigger('change');
      if (hash.preview === 'partnerdd') $('#mcPartner').select2('open');
    });
    if (hash.tab === 'order') {
      state.tab = 'order';
      $tabs.find('.mc-tab').removeClass('is-active').filter('[data-tab="order"]').addClass('is-active');
      $root.find('.js-order-only').show();
    }
    if (hash.tab === 'participant') {
      state.tab = 'participant';
      $tabs.find('.mc-tab').removeClass('is-active').filter('[data-tab="participant"]').addClass('is-active');
      $root.find('.js-participant-only').show();
      if (hash.result) $('#mcResult').val(hash.result);
      renderMissionChip();
      if (hash.expand) {          // 미리보기/QA용: 첫 행 주문 펼침
        $tbody.one('mc:rendered', function () {
          var $f = $tbody.find('tr.is-clickable' + (hash.expand === 'multi' ? '.is-multi' : '')).first(); if (!$f.length) return;
          if ($f.hasClass('is-multi')) { openRider($f); if (hash.sub) toggleSubOrders($tbody.find('tr.js-sub-row').first()); } else openOrders($f);
        });
      }
    }
    load(true);
  });

  // 디버깅/연동 편의
  window.MissionList = { state: state, API: API, CONFIG: CONFIG, reload: function () { load(true); } };

})(jQuery, window);
