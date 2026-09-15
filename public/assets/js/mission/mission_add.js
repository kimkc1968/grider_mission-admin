/* =========================================================
   미션 추가 (mission_add.js)
   - 기존 어드민 「미션 추가」 폼과 동일 항목. 저장 시 지역별로 미션 N개 생성.
   - CONFIG.USE_MOCK = true 이면 저장을 흉내내고 미션 내역으로 이동.
   ========================================================= */
(function ($, window) {
  'use strict';

  var CONFIG = {
    USE_MOCK: true,
    API_SAVE: '/admin/missions',
    LIST_URL: 'mission_list.html',
    MAX_PARTNERS: 3,
    MAX_TIERS: 5,
    MAX_TIME_RANGES: 3,
    MAX_PERIOD_DAYS: 31
  };

  /* 마스터 — 실서비스에서는 서버(고릴라 동기화)에서 내려주는 목록으로 대체 */
  var PARTNERS = ['요기배달', '땡배달', '올리브영', '쓱배달', '홈플러스', 'GS25', 'GS슈퍼', '배스킨라빈스', '파리바게뜨', '해피크루',
                  '세븐일레븐', '스타벅스', 'CU', '이마트24', '이마트에브리데이', '헝그리판다', '던킨도너츠(SPC)', '바로고', '버거킹', 'BHC'];
  var REGIONS = ['서울 강남구', '서울 강동구', '서울 송파구', '서울 서초구', '서울 관악구', '서울 동작구', '서울 영등포구', '서울 마포구', '서울 용산구', '서울 성동구', '서울 광진구', '서울 중구', '서울 종로구',
                 '경기 광명시', '경기 성남시 분당구', '경기 성남시 수정구', '경기 하남시', '경기 평택시', '경기 안산시 단원구',
                 '인천 남동구', '인천 미추홀구', '충남 천안시 서북구', '대전 동구', '대전 유성구', '광주 광산구', '경남 김해시'];

  var $form;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function comma(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function toast(icon, title) { Swal.fire({ toast: true, position: 'top-end', icon: icon, title: title, showConfirmButton: false, timer: 1800 }); }

  /* ---------------------------------------------------------
     화주사 체크 그리드 — 전체 주문 또는 개별 최대 3개
  --------------------------------------------------------- */
  function renderPartners() {
    var html = '<label class="ma-check"><input type="checkbox" name="partner" value="ALL"><span>전체 주문</span></label>';
    PARTNERS.forEach(function (p) { html += '<label class="ma-check"><input type="checkbox" name="partner" value="' + esc(p) + '"><span>' + esc(p) + '</span></label>'; });
    $('#maPartners').html(html);
  }
  function syncPartners(changed) {
    var $all = $('input[name="partner"][value="ALL"]');
    var $each = $('input[name="partner"]').not($all);
    if (changed && changed.value === 'ALL') {
      if ($all.is(':checked')) $each.prop('checked', false);
    } else if (changed && $(changed).is(':checked')) {
      $all.prop('checked', false);
    }
    var n = $each.filter(':checked').length;
    var allOn = $all.is(':checked');
    $each.prop('disabled', allOn || (n >= CONFIG.MAX_PARTNERS ? true : false)).filter(':checked').prop('disabled', allOn);
    if (!allOn && n < CONFIG.MAX_PARTNERS) $each.prop('disabled', false);
    $all.prop('disabled', n > 0);
  }

  /* ---------------------------------------------------------
     미션 진행 시간 (반복) — 최대 3구간
  --------------------------------------------------------- */
  function addTimeRange(from, to) {
    var $list = $('#maTimeRanges');
    if ($list.children().length >= CONFIG.MAX_TIME_RANGES) return;
    var $row = $('<div class="ma-list__row">' +
      '<input type="time" class="ma-input" name="timeFrom" value="' + (from || '') + '" style="width:130px" placeholder="시작 시간">' +
      '<span class="muted">~</span>' +
      '<input type="time" class="ma-input" name="timeTo" value="' + (to || '') + '" style="width:130px" placeholder="종료 시간">' +
      '<button type="button" class="ma-btn-add js-time-add">추가</button>' +
      '<button type="button" class="ma-btn-del js-time-del">삭제</button>' +
    '</div>');
    $list.append($row);
    refreshTimeButtons();
  }
  function refreshTimeButtons() {
    var $rows = $('#maTimeRanges .ma-list__row');
    $rows.find('.js-time-add').hide().end().find('.js-time-del').show();
    $rows.last().find('.js-time-add').toggle($rows.length < CONFIG.MAX_TIME_RANGES);
    if ($rows.length === 1) $rows.find('.js-time-del').hide();
  }

  /* ---------------------------------------------------------
     미션 보상 단계 — 최대 5단계, 건수 오름차순
  --------------------------------------------------------- */
  function addTier(count, zone, reward) {
    var $list = $('#maTiers');
    if ($list.children().length >= CONFIG.MAX_TIERS) return;
    var $row = $('<div class="ma-list__row">' +
      '<span class="ma-tier-idx"></span>' +
      '<label class="ma-unit"><input type="number" name="tierCount" min="1" placeholder="0" value="' + (count || '') + '"><span>건 완료</span></label>' +
      '<label class="ma-unit"><input type="number" name="tierZone" min="0" placeholder="0" value="' + (zone || 0) + '"><span>건 권역 완료</span></label>' +
      '<label class="ma-unit ma-unit--wide"><input type="number" name="tierReward" min="0" step="100" placeholder="0" value="' + (reward || '') + '"><span>원 지급</span></label>' +
      '<button type="button" class="ma-btn-del js-tier-del">삭제</button>' +
    '</div>');
    $list.append($row);
    refreshTiers();
  }
  function refreshTiers() {
    var $rows = $('#maTiers .ma-list__row');
    $rows.each(function (i) { $(this).find('.ma-tier-idx').text((i + 1) + '단계'); });
    $rows.find('.js-tier-del').toggle($rows.length > 1);
    $('#maTierAdd').prop('disabled', $rows.length >= CONFIG.MAX_TIERS);
    // 권역 완료 입력은 권역 카운팅 조건일 때만
    var zoneOn = $('#maCountZone').is(':checked');
    $rows.find('input[name="tierZone"]').prop('disabled', !zoneOn).closest('.ma-unit').css('opacity', zoneOn ? 1 : .45);
  }

  /* ---------------------------------------------------------
     섹션 토글
  --------------------------------------------------------- */
  function syncSections() {
    var kind = $('input[name="kind"]:checked').val();
    $('#secRepeat').prop('hidden', kind !== 'REPEAT');
    $('#secPeriod').prop('hidden', kind !== 'PERIOD');
    $('#maWeekdays').prop('hidden', $('input[name="repeatBasis"]:checked').val() !== 'WEEKDAY');

    var dist = $('#maCountDistance').is(':checked'), zone = $('#maCountZone').is(':checked');
    $('#secCounting').prop('hidden', !(dist || zone));
    $('#rowDistance').prop('hidden', !dist);
    $('#rowZone').prop('hidden', !zone);

    $('#secFirstCome').prop('hidden', $('input[name="firstCome"]:checked').val() !== '1');

    var commute = $('#maCondCommute').is(':checked'), time = $('#maCondTime').is(':checked');
    $('#secComplete').prop('hidden', !(commute || time));
    $('#rowCommute').prop('hidden', !commute);
    $('#rowTime').prop('hidden', !time);

    // 기준 시간에 따라 '접수 후 / 배정 후' 라벨
    var base = kind === 'REPEAT' ? $('input[name="baseTimeR"]:checked').val() : $('input[name="baseTimeP"]:checked').val();
    $('#maTimeCondLabel').text(base === 'ASSIGNED' ? '배정 후' : '접수 후');
    refreshTiers();
  }

  /* ---------------------------------------------------------
     값 수집 / 검증
  --------------------------------------------------------- */
  function collect() {
    var kind = $('input[name="kind"]:checked').val();
    var partners = $('input[name="partner"]:checked').map(function () { return this.value; }).get();
    var d = {
      agency: $('#maAgency').val(),
      regions: $('#maRegions').val() || [],
      partners: partners,
      title: $.trim($('#maTitle').val()),
      description: $.trim($('#maDesc').val()),
      kind: kind,
      repeat: kind === 'REPEAT' ? {
        basis: $('input[name="repeatBasis"]:checked').val(),
        weekdays: $('input[name="weekday"]:checked').map(function () { return Number(this.value); }).get(),
        baseTime: $('input[name="baseTimeR"]:checked').val(),
        timeRanges: $('#maTimeRanges .ma-list__row').map(function () { return { from: $(this).find('[name="timeFrom"]').val(), to: $(this).find('[name="timeTo"]').val() }; }).get(),
        sharedCall: $('input[name="sharedR"]:checked').val()
      } : null,
      period: kind === 'PERIOD' ? {
        start: $('#maPeriodStart').val(), end: $('#maPeriodEnd').val(),
        dailyReset: $('input[name="dailyReset"]:checked').val() === '1',
        baseTime: $('input[name="baseTimeP"]:checked').val(),
        timeFrom: $('#maPeriodTimeFrom').val(), timeTo: $('#maPeriodTimeTo').val(),
        sharedCall: $('input[name="sharedP"]:checked').val()
      } : null,
      counting: {
        distance: $('#maCountDistance').is(':checked') ? Number($('#maDistance').val() || 0) : null,
        zone: $('#maCountZone').is(':checked') ? $('#maZone').val() : null
      },
      firstCome: $('input[name="firstCome"]:checked').val() === '1' ? Number($('#maFirstComeN').val() || 0) : null,
      complete: {
        commute: $('#maCondCommute').is(':checked') ? Number($('#maCommuteN').val() || 0) : null,
        limitMin: $('#maCondTime').is(':checked') ? Number($('#maLimitMin').val() || 0) : null,
        firstCallOnly: $('#maCondFirstCall').is(':checked')
      },
      rewardType: 'CASH',
      tiers: $('#maTiers .ma-list__row').map(function () {
        return { count: Number($(this).find('[name="tierCount"]').val() || 0), zoneCount: Number($(this).find('[name="tierZone"]').val() || 0), reward: Number($(this).find('[name="tierReward"]').val() || 0) };
      }).get()
    };
    return d;
  }

  function validate(d) {
    var errs = [];
    $('.is-error').removeClass('is-error');
    function bad(sel, msg) { $(sel).addClass('is-error'); errs.push(msg); }

    if (!d.agency) bad('#maAgency', '브랜드를 선택해주세요.');
    if (!d.regions.length) bad('#maRegions + .select2-container .select2-selection', '지역을 1개 이상 선택해주세요.');
    if (!d.partners.length) bad('#maPartnerBox', '화주사를 선택해주세요. (전체 주문 또는 최대 3개)');
    if (!d.title) bad('#maTitle', '미션 제목을 입력해주세요.');

    if (d.kind === 'REPEAT') {
      if (d.repeat.basis === 'WEEKDAY' && !d.repeat.weekdays.length) errs.push('요일 반복은 요일을 1개 이상 선택해주세요.');
      d.repeat.timeRanges.forEach(function (r, i) { if (!r.from || !r.to) errs.push('미션 진행 시간 ' + (i + 1) + '구간의 시작/종료 시간을 입력해주세요.'); });
    } else {
      if (!d.period.start || !d.period.end) { bad('#maPeriodStart, #maPeriodEnd', '기간을 선택해주세요.'); }
      else {
        var s = new Date(d.period.start), e = new Date(d.period.end);
        if (e <= s) bad('#maPeriodEnd', '종료 시각이 시작 시각보다 늦어야 합니다.');
        if ((e - s) / 86400000 > CONFIG.MAX_PERIOD_DAYS) bad('#maPeriodEnd', '기간은 최대 한 달까지 선택 가능합니다.');
      }
    }
    if (d.counting.distance != null && d.counting.distance <= 0) bad('#maDistance', '거리 조건(m)을 입력해주세요.');
    if (d.counting.zone === '') bad('#maZone', '권역을 선택해주세요.');
    if (d.firstCome != null && d.firstCome <= 0) bad('#maFirstComeN', '선착순 인원을 입력해주세요.');
    if (d.complete.commute != null && d.complete.commute <= 0) bad('#maCommuteN', '출퇴근 달성 횟수를 입력해주세요.');
    if (d.complete.limitMin != null && d.complete.limitMin <= 0) bad('#maLimitMin', '완료 시간(분)을 입력해주세요.');
    if (d.complete.commute == null && d.complete.limitMin == null && !d.complete.firstCallOnly) errs.push('미션 완료 조건을 1개 이상 선택해주세요.');

    if (!d.tiers.length) errs.push('미션 보상 단계를 1개 이상 입력해주세요.');
    var prev = 0;
    d.tiers.forEach(function (t, i) {
      var $row = $('#maTiers .ma-list__row').eq(i);
      if (t.count <= 0) { $row.find('[name="tierCount"]').closest('.ma-unit').addClass('is-error'); errs.push((i + 1) + '단계 완료 건수를 입력해주세요.'); }
      else if (t.count <= prev) { $row.find('[name="tierCount"]').closest('.ma-unit').addClass('is-error'); errs.push((i + 1) + '단계 건수는 이전 단계보다 커야 합니다. (오름차순)'); }
      if (t.reward <= 0) { $row.find('[name="tierReward"]').closest('.ma-unit').addClass('is-error'); errs.push((i + 1) + '단계 지급 금액을 입력해주세요.'); }
      prev = t.count;
    });
    return errs;
  }

  /* ---------------------------------------------------------
     제출
  --------------------------------------------------------- */
  var AGENCY_TEXT = { GR: '그라이더', GRP: '그라이더플러스', ALL: '그라이더 + 그라이더플러스' };
  var BASE_TEXT = { ASSIGNED: '배정한 시간', COMPLETED: '완료한 시간' };
  var SHARE_TEXT = { ALL: '자사+공유포함', OWN: '자사만', SHARED: '공유만' };
  var BASIS_TEXT = { DAILY: '일일', WEEKLY: '주간', MONTHLY: '월간', WEEKDAY: '요일' };

  function summaryHtml(d) {
    var when = d.kind === 'REPEAT'
      ? '반복 · ' + BASIS_TEXT[d.repeat.basis] + ' · ' + d.repeat.timeRanges.map(function (r) { return r.from + '~' + r.to; }).join(', ')
      : '기간한정 · ' + d.period.start.replace('T', ' ') + ' ~ ' + d.period.end.replace('T', ' ') + (d.period.dailyReset ? ' · 매일 초기화' : '');
    var base = d.kind === 'REPEAT' ? d.repeat.baseTime : d.period.baseTime;
    var cond = [];
    if (d.complete.limitMin != null) cond.push((base === 'ASSIGNED' ? '배정' : '접수') + ' 후 ' + d.complete.limitMin + '분 내 완료');
    if (d.complete.commute != null) cond.push('출퇴근 ' + d.complete.commute + '회');
    if (d.complete.firstCallOnly) cond.push('첫 콜 완료 시에만');
    return '<dl class="ma-summary">' +
      '<dt>브랜드</dt><dd>' + esc(AGENCY_TEXT[d.agency]) + '</dd>' +
      '<dt>지역 (' + d.regions.length + '개 → 미션 ' + d.regions.length + '개 생성)</dt><dd>' + esc(d.regions.slice(0, 3).join(', ')) + (d.regions.length > 3 ? ' 외 ' + (d.regions.length - 3) + '개' : '') + '</dd>' +
      '<dt>화주사</dt><dd>' + esc(d.partners[0] === 'ALL' ? '전체 주문' : d.partners.join(', ')) + '</dd>' +
      '<dt>미션 제목</dt><dd>' + esc(d.title) + '</dd>' +
      '<dt>진행</dt><dd>' + esc(when) + '</dd>' +
      '<dt>기준 시간 · 공유콜</dt><dd>' + esc(BASE_TEXT[base]) + ' · ' + esc(SHARE_TEXT[d.kind === 'REPEAT' ? d.repeat.sharedCall : d.period.sharedCall]) + '</dd>' +
      '<dt>완료 조건</dt><dd>' + esc(cond.join(' · ') || '-') + '</dd>' +
      (d.firstCome != null ? '<dt>선착순</dt><dd>' + d.firstCome + '명까지 지급</dd>' : '') +
      '<dt>보상 (최상위 1단계 지급)</dt><dd>' + d.tiers.map(function (t, i) { return (i + 1) + '단계 ' + t.count + '건 → ' + comma(t.reward) + '원'; }).join(' / ') + '</dd>' +
    '</dl>';
  }

  function submit() {
    var d = collect();
    var errs = validate(d);
    if (errs.length) {
      Swal.fire({ icon: 'warning', title: '입력을 확인해주세요', html: '<div style="text-align:left;font-size:13px;line-height:1.8">' + errs.map(function (e) { return '· ' + esc(e); }).join('<br>') + '</div>' });
      $('.is-error').first().closest('.ma-row')[0] && $('.is-error').first().closest('.ma-row')[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    Swal.fire({
      title: '이 설정으로 미션을 추가할까요?',
      html: summaryHtml(d),
      icon: 'question', showCancelButton: true, confirmButtonText: '미션 추가', cancelButtonText: '돌아가기', confirmButtonColor: '#4c6ed7', width: 560
    }).then(function (r) {
      if (!r.isConfirmed) return;
      save(d).done(function () {
        Swal.fire({ icon: 'success', title: '미션 ' + d.regions.length + '개가 추가되었습니다.', text: '미션 내역에서 확인할 수 있습니다.', confirmButtonText: '미션 내역으로', showCancelButton: true, cancelButtonText: '계속 추가' })
          .then(function (x) { if (x.isConfirmed) window.location.href = CONFIG.LIST_URL + '#status=BEFORE'; else resetForm(); });
      }).fail(function () { Swal.fire({ icon: 'error', title: '저장에 실패했습니다.' }); });
    });
  }

  function save(d) {
    if (!CONFIG.USE_MOCK) return $.ajax({ type: 'POST', url: CONFIG.API_SAVE, contentType: 'application/json', data: JSON.stringify(d) });
    var def = $.Deferred(); setTimeout(function () { def.resolve({ ok: true }); }, 300); return def.promise();
  }

  function resetForm() {
    $form[0].reset();
    $('#maRegions').val(null).trigger('change');
    $('#maTimeRanges').empty(); addTimeRange('', '');
    $('#maTiers').empty(); addTier();
    syncPartners(); syncSections();
    $('.is-error').removeClass('is-error');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------------------------------------------------
     초기화
  --------------------------------------------------------- */
  $(function () {
    $form = $('#maForm');
    if (!$form.length) return;

    renderPartners();
    REGIONS.forEach(function (r) { $('#maRegions').append('<option value="' + esc(r) + '">' + esc(r) + '</option>'); });
    if ($.fn.select2) $('#maRegions').select2({ placeholder: '적용 지역을 선택해주세요', closeOnSelect: false, width: '100%' });

    addTimeRange('', '');
    addTier();
    syncPartners();
    syncSections();

    $form.on('change', 'input[name="partner"]', function () { syncPartners(this); });
    $form.on('change', 'input[name="kind"], input[name="repeatBasis"], input[name="baseTimeR"], input[name="baseTimeP"], #maCountDistance, #maCountZone, input[name="firstCome"], #maCondCommute, #maCondTime', syncSections);

    $form.on('click', '.js-time-add', function () { addTimeRange('', ''); });
    $form.on('click', '.js-time-del', function () { $(this).closest('.ma-list__row').remove(); refreshTimeButtons(); });
    $('#maTierAdd').on('click', function () { addTier(); });
    $form.on('click', '.js-tier-del', function () { $(this).closest('.ma-list__row').remove(); refreshTiers(); });

    $form.on('submit', function (e) { e.preventDefault(); submit(); });
    $('#maCancel').on('click', function () { window.location.href = CONFIG.LIST_URL; });

    // 기간한정 기본값: 오늘 17:00 ~ 22:00
    var t = new Date(); var d = t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
    $('#maPeriodStart').val(d + 'T17:00'); $('#maPeriodEnd').val(d + 'T22:00');
  });

  window.MissionAdd = { CONFIG: CONFIG, collect: collect, validate: validate };
})(jQuery, window);
