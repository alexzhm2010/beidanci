/**
 * 统计模块
 * 功能: 学习数据看板、月度打卡日历、7天活动图、熟练度分布、年度看板、激励信息
 */
window.App = window.App || {};
App.Stats = (function () {
  var charts = {};
  var calendarState = { year: 0, month: 0 }; // 当前显示的年月
  var yearlyState = { year: 0 }; // 年度看板当前年份
  var cachedWords = [];
  var cachedRecords = [];
  // v1.10.4 预聚合索引 (O(N) 一次构建, 各模块 O(1) 查表)
  var dayBuckets = {};        // key: 'YYYY-MM-DD' → { records: [], count, known, newWords: Set }
  var monthBuckets = {};      // key: 'YYYY-MM' → { records: [], count, known, newWords: Set, wordIds: Set }
  var profDist = { 0: 0, 40: 0, 60: 0, 80: 0 };  // 熟练度分布: <40/40-60/60-80/80+

  // v1.11.0 ES Module 重构: Chart.js 按需动态加载 (取代 index.html 全局 <script>)
  var _Chart = null;
  async function ensureChart() {
    if (_Chart) return _Chart;
    var mod = await import('chart.js/auto');
    _Chart = mod.default || mod;
    return _Chart;
  }

  function init() {
    // 统计模块无需绑定事件, 每次 show() 时刷新
  }

  /** v1.10.4 O(N) 预聚合: 一次遍历 records + words 构建所有索引 */
  function buildAggregates(records, words) {
    dayBuckets = {};
    monthBuckets = {};
    profDist = { 0: 0, 40: 0, 60: 0, 80: 0 };

    // 1) records → 按天/月分桶 (O(N))
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var d = new Date(r.timestamp);
      var dKey = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      var mKey = d.getFullYear() + '-' + pad2(d.getMonth() + 1);

      // 天桶
      var db = dayBuckets[dKey];
      if (!db) { db = { count: 0, known: 0, newWords: {} }; dayBuckets[dKey] = db; }
      db.count++;
      if (r.isKnown) db.known++;
      if (r.sessionType === 'new' && r.wordId) db.newWords[r.wordId] = true;

      // 月桶
      var mb = monthBuckets[mKey];
      if (!mb) { mb = { count: 0, known: 0, newWords: {}, wordIds: {} }; monthBuckets[mKey] = mb; }
      mb.count++;
      if (r.isKnown) mb.known++;
      if (r.sessionType === 'new' && r.wordId) mb.newWords[r.wordId] = true;
      if (r.wordId) mb.wordIds[r.wordId] = true;
    }

    // 2) words → 熟练度分布 (O(W))
    for (var j = 0; j < words.length; j++) {
      var w = words[j];
      if (!w.totalCount || w.totalCount === 0) continue;
      var p = w.knownCount / w.totalCount;
      if (p < 0.4) profDist[0]++;
      else if (p < 0.6) profDist[40]++;
      else if (p < 0.8) profDist[60]++;
      else profDist[80]++;
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 从 dayBuckets 查某天的记录数 (O(1)) */
  function getDayCount(y, m, d) {
    var key = y + '-' + pad2(m + 1) + '-' + pad2(d);
    var b = dayBuckets[key];
    return b ? b.count : 0;
  }

  /** 从 dayBuckets 查某天是否活跃 (O(1)) */
  function isDayActive(y, m, d) {
    var key = y + '-' + pad2(m + 1) + '-' + pad2(d);
    return !!dayBuckets[key];
  }

  async function show() {
    try {
      // 初始化日历状态为当月
      var now = new Date();
      calendarState = { year: now.getFullYear(), month: now.getMonth() };
      yearlyState = { year: now.getFullYear() };

      // 并行拉取: 单词数据 + 词库总数 + 当年学习记录 (三者无依赖, 并行减少等待)
      // 记录只拉取当年1月1日至今 (日历/近7天/月度/年度看板都只用到当年数据, 相比2年数据量减半)
      var yearStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).getTime();

      var results = await Promise.all([
        App.DB.getLearnedWords(),
        App.DB.getWordCount().catch(function () { return 0; }),
        App.DB.getRecords(yearStart).catch(function (e) { console.error('加载学习记录失败:', e); return []; }),
      ]);

      var learnedWords = results[0];
      var total = results[1] || 0;
      var records = results[2] || [];

      var learned = learnedWords.length;
      var newCount = total - learned;
      if (newCount < 0) newCount = 0;
      var mastered = learnedWords.filter(function (w) {
        return w.totalCount && w.totalCount > 0 && w.knownCount / w.totalCount >= 0.80;
      }).length;

      var words = learnedWords;
      var wordCounts = [total, newCount, learned, mastered];

      cachedWords = words;
      cachedRecords = records;

      // v1.10.4 O(N) 预聚合: 后续 streak/日历/年度看板/月度统计全部查表
      buildAggregates(records, words);

      render(words, records, wordCounts);
    } catch (e) {
      document.getElementById('statsContent').innerHTML =
        '<div class="stats-empty"><h3>加载失败</h3><p>' + App.Utils.escapeHtml(e.message) + '</p></div>';
    }
  }

  async function render(words, records, wordCounts) {
    var Chart = await ensureChart();
    // 销毁旧图表
    Object.keys(charts).forEach(function (k) {
      if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    });

    var total = wordCounts[0];
    var newCount = wordCounts[1];
    var learned = wordCounts[2];
    var mastered = wordCounts[3];

    if (total === 0) {
      document.getElementById('statsContent').innerHTML =
        '<div class="stats-empty"><h3>暂无数据</h3><p>请先导入或添加单词开始学习之旅</p></div>';
      return;
    }

    // ---- 计算统计数据 (v1.10.4: 全部查表 O(1), 不再遍历 records) ----
    var dueNow = App.Algorithm.getDueCount(words);
    var upcoming24h = App.Algorithm.getUpcomingCount(words, 24);

    // 今日 (查 dayBuckets)
    var todayStart = App.Utils.todayStart();
    var today = new Date();
    var todayBucket = dayBuckets[today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate())];
    var todayCount = todayBucket ? todayBucket.count : 0;
    var todayKnown = todayBucket ? todayBucket.known : 0;
    var todayAccuracy = todayCount > 0 ? Math.round((todayKnown / todayCount) * 100) : 0;

    // 近7天 (查 dayBuckets, O(7))
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = App.Utils.daysAgoStart(i);
      var dd = new Date(d);
      var bucket = dayBuckets[dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '-' + pad2(dd.getDate())];
      days.push({
        date: d,
        total: bucket ? bucket.count : 0,
        known: bucket ? bucket.known : 0,
      });
    }

    // 连续天数 (查 dayBuckets, O(streak) 而非 O(365*N))
    var streak = 0;
    for (var i2 = 0; i2 < 365; i2++) {
      var dd2 = new Date(App.Utils.daysAgoStart(i2));
      var key2 = dd2.getFullYear() + '-' + pad2(dd2.getMonth() + 1) + '-' + pad2(dd2.getDate());
      if (dayBuckets[key2]) streak++;
      else if (i2 > 0) break;
    }

    // 熟练度分布
    var dist = {
      '未学习': newCount,
      '已学习': learned - mastered,
      '已掌握': mastered,
    };

    // 本周新词 (查 dayBuckets, O(7))
    var weekStart = App.Utils.daysAgoStart(6);
    var weekNewWords = 0;
    for (var i3 = 0; i3 < 7; i3++) {
      var dd3 = new Date(App.Utils.daysAgoStart(i3));
      var b3 = dayBuckets[dd3.getFullYear() + '-' + pad2(dd3.getMonth() + 1) + '-' + pad2(dd3.getDate())];
      if (b3) weekNewWords += Object.keys(b3.newWords).length;
    }

    // 总体正确率 (查 monthBuckets 汇总, O(12))
    var totalKnown = 0;
    var totalRecords = 0;
    Object.keys(monthBuckets).forEach(function (mk) {
      totalKnown += monthBuckets[mk].known;
      totalRecords += monthBuckets[mk].count;
    });
    var overallAccuracy = totalRecords > 0 ? Math.round((totalKnown / totalRecords) * 100) : 0;

    // ---- 渲染 ----
    var html =
      // ===== 整体进展 =====
      '<div class="stats-section-title">整体进展</div>' +
      // 紧凑仪表盘: 8个指标合为一个面板
      '<div class="stats-dashboard">' +
        cell(total, '词库', '') +
        cell(learned, '已学', 'success') +
        cell(dueNow, '待复习', 'danger') +
        cell(mastered, '已掌握', 'info') +
        cell(todayCount, '今日', 'warning') +
        cell(todayAccuracy + '%', '正确率', todayAccuracy >= 80 ? 'success' : todayAccuracy >= 50 ? 'warning' : 'danger') +
        cell(upcoming24h, '24h到期', 'info') +
        cell(streak, '连续天', 'success') +
      '</div>' +
      // 激励语
      '<div class="chart-card" style="margin-top:12px;text-align:center;padding:12px;">' +
        '<p style="font-size:15px;font-weight:500;color:var(--color-primary);">' +
          App.Utils.escapeHtml(getMessage(streak, todayCount, todayAccuracy, learned, total, mastered)) +
        '</p>' +
      '</div>' +
      // 整体图表
      '<div class="stats-charts">' +
        '<div class="chart-card"><h3>近7天学习量</h3><div class="chart-wrapper"><canvas id="activityChart"></canvas></div></div>' +
        '<div class="chart-card"><h3>学习进度</h3><div class="chart-wrapper"><canvas id="proficiencyChart"></canvas></div></div>' +
      '</div>' +
      // ===== 月度进展 =====
      '<div class="stats-section-title" style="margin-top:24px;">月度进展</div>' +
      // 月度打卡日历
      '<div class="chart-card">' +
        '<h3>月度打卡记录</h3>' +
        '<div id="calendarContainer"></div>' +
      '</div>' +
      // 月度统计
      '<div id="monthlyStatsContainer" style="margin-top:12px;"></div>' +
      // ===== 年度看板 =====
      '<div class="stats-section-title" style="margin-top:24px;">年度看板</div>' +
      '<div class="chart-card">' +
        '<div class="yearly-header">' +
          '<h3>年度学习看板</h3>' +
          '<div class="yearly-nav">' +
            '<button class="btn btn-sm btn-outline" id="btnPrevYear">&lt;</button>' +
            '<span id="yearlyLabel">' + yearlyState.year + '年</span>' +
            '<button class="btn btn-sm btn-outline" id="btnNextYear">&gt;</button>' +
          '</div>' +
        '</div>' +
        '<div class="chart-wrapper" style="height:300px;"><canvas id="yearlyChart"></canvas></div>' +
      '</div>';

    document.getElementById('statsContent').innerHTML = html;

    // 渲染日历
    renderCalendar();

    // 渲染年度看板
    renderYearlyChart();

    // 渲染图表
    if (typeof Chart !== 'undefined') {
      renderActivityChart(days);
      renderProficiencyChart(dist);
    }

    // 绑定年度导航
    document.getElementById('btnPrevYear').addEventListener('click', function () {
      yearlyState.year--;
      renderYearlyChart();
    });
    document.getElementById('btnNextYear').addEventListener('click', function () {
      yearlyState.year++;
      renderYearlyChart();
    });
  }

  // ========== 月度打卡日历 ==========

  function renderCalendar() {
    var y = calendarState.year;
    var m = calendarState.month;
    var monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    var weekDays = ['日', '一', '二', '三', '四', '五', '六'];

    // 计算月份天数
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var firstDay = new Date(y, m, 1).getDay(); // 0=周日

    // 按天统计学习记录数 (v1.10.4: 查 dayBuckets O(31) 而非 O(31*N))
    var dayCounts = {};
    for (var d = 1; d <= daysInMonth; d++) {
      dayCounts[d] = getDayCount(y, m, d);
    }

    // 构建日历HTML
    var html =
      '<div class="calendar-nav">' +
        '<button class="btn btn-sm btn-outline" id="btnPrevMonth">&lt;</button>' +
        '<span class="calendar-title">' + y + '年 ' + monthNames[m] + '</span>' +
        '<button class="btn btn-sm btn-outline" id="btnNextMonth">&gt;</button>' +
      '</div>' +
      '<div class="calendar-legend">' +
        '<span class="legend-item"><span class="medal medal-gold">🥇</span>≥300</span>' +
        '<span class="legend-item"><span class="medal medal-silver">🥈</span>≥200</span>' +
        '<span class="legend-item"><span class="medal medal-bronze">🥉</span>≥100</span>' +
      '</div>' +
      '<div class="calendar-grid">' +
        weekDays.map(function (w) { return '<div class="calendar-weekday">' + w + '</div>'; }).join('');

    // 空白格
    for (var blank = 0; blank < firstDay; blank++) {
      html += '<div class="calendar-day empty"></div>';
    }

    // 日期格
    var today = new Date();
    for (var day = 1; day <= daysInMonth; day++) {
      var count = dayCounts[day] || 0;
      var isToday = (y === today.getFullYear() && m === today.getMonth() && day === today.getDate());
      var medal = '';
      var medalClass = '';

      if (count >= 300) { medal = '🥇'; medalClass = 'has-medal gold'; }
      else if (count >= 200) { medal = '🥈'; medalClass = 'has-medal silver'; }
      else if (count >= 100) { medal = '🥉'; medalClass = 'has-medal bronze'; }

      var countDisplay = count > 0 ? count : '';
      html += '<div class="calendar-day ' + medalClass + (isToday ? ' today' : '') + '">' +
        '<div class="day-num">' + day + '</div>' +
        (medal ? '<div class="day-medal">' + medal + '</div>' : '') +
        (count > 0 && !medal ? '<div class="day-count">' + count + '</div>' : '') +
      '</div>';
    }

    html += '</div>';

    document.getElementById('calendarContainer').innerHTML = html;

    // 绑定日历导航 (每次渲染都要重新绑定, 因为 innerHTML 替换了按钮)
    document.getElementById('btnPrevMonth').addEventListener('click', function () {
      calendarState.month--;
      if (calendarState.month < 0) { calendarState.month = 11; calendarState.year--; }
      renderCalendar();
    });
    document.getElementById('btnNextMonth').addEventListener('click', function () {
      calendarState.month++;
      if (calendarState.month > 11) { calendarState.month = 0; calendarState.year++; }
      renderCalendar();
    });

    // 渲染月度统计
    renderMonthlyStats(y, m, dayCounts);
  }

  function renderMonthlyStats(y, m, dayCounts) {
    // v1.10.4: 查 monthBuckets O(1) 而非 O(N) filter
    var mKey = y + '-' + pad2(m + 1);
    var mb = monthBuckets[mKey] || { count: 0, known: 0, newWords: {}, wordIds: {} };
    var monthTotal = mb.count;
    var monthKnown = mb.known;
    var monthNewWords = Object.keys(mb.newWords).length;
    var monthAccuracy = monthTotal > 0 ? Math.round((monthKnown / monthTotal) * 100) : 0;

    // 活跃天数 + 奖牌数 (查 dayCounts, O(31))
    var activeDays = 0;
    var goldDays = 0, silverDays = 0, bronzeDays = 0;
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var c = dayCounts[d] || 0;
      if (c > 0) activeDays++;
      if (c >= 300) goldDays++;
      else if (c >= 200) silverDays++;
      else if (c >= 100) bronzeDays++;
    }

    // 当月接触/掌握词 (查 cachedWords 一次, 不再嵌套 monthBuckets)
    var monthStart = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    var monthEnd = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();
    var monthLearnedWords = 0;
    var monthMasteredWords = 0;
    for (var i = 0; i < cachedWords.length; i++) {
      var w = cachedWords[i];
      if (w.lastLearnTime && w.lastLearnTime >= monthStart && w.lastLearnTime < monthEnd) {
        monthLearnedWords++;
      }
      if (w.lastKnownTime && w.lastKnownTime >= monthStart && w.lastKnownTime < monthEnd) {
        if (w.totalCount > 0 && w.knownCount / w.totalCount >= 0.80) {
          monthMasteredWords++;
        }
      }
    }

    // 熟练度分布 (查预聚合 profDist, O(1))
    var prof0_40 = profDist[0];
    var prof40_60 = profDist[40];
    var prof60_80 = profDist[60];
    var prof80_100 = profDist[80];

    var html =
      '<div class="chart-card">' +
        '<h3>' + y + '年' + (m + 1) + '月统计</h3>' +
        // 紧凑仪表盘: 8个指标合为一个面板
        '<div class="stats-dashboard">' +
          cell(monthTotal, '学习次数', 'warning') +
          cell(monthNewWords, '新学词', 'success') +
          cell(monthLearnedWords, '接触词', 'info') +
          cell(monthAccuracy + '%', '正确率', monthAccuracy >= 80 ? 'success' : monthAccuracy >= 50 ? 'warning' : 'danger') +
          cell(activeDays, '活跃天', '') +
          cell(goldDays, '金牌🥇', 'warning') +
          cell(silverDays, '银牌🥈', 'info') +
          cell(bronzeDays, '铜牌🥉', '') +
        '</div>' +
        // 熟练度分布
        '<div style="margin-top:12px;">' +
          '<h4 style="font-size:13px;margin-bottom:8px;color:var(--color-text-light);">熟练度分布</h4>' +
          '<div class="proficiency-distribution">' +
            profBar('<40%', prof0_40, '#e74c3c') +
            profBar('40~60%', prof40_60, '#f39c12') +
            profBar('60~80%', prof60_80, '#3498db') +
            profBar('80~100%', prof80_100, '#27ae60') +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('monthlyStatsContainer').innerHTML = html;
  }

  function profBar(label, count, color) {
    var total = cachedWords.length || 1;
    var pct = Math.round((count / total) * 100);
    return '<div class="dist-row">' +
      '<div class="dist-label">' + label + '</div>' +
      '<div class="dist-bar"><div class="dist-fill" style="width:' + pct + '%;background:' + color + ';">' + count + '</div></div>' +
    '</div>';
  }

  // ========== 年度看板 ==========

  async function renderYearlyChart() {
    var Chart = await ensureChart();
    if (typeof Chart === 'undefined') {
      var yc = document.getElementById('yearlyChart');
      if (yc) yc.parentElement.innerHTML = '<p style="text-align:center;color:var(--color-text-light);padding:40px 0;">图表库加载失败，请检查网络</p>';
      return;
    }
    var y = yearlyState.year;
    document.getElementById('yearlyLabel').textContent = y + '年';

    var monthLabels = [];
    var newWordCounts = [];
    var avgProficiencies = [];

    // v1.10.4: 查 monthBuckets O(12) 而非 O(24*N) 双重循环
    // 先构建 wordId→word 映射, 用于算月度平均熟练度
    var wordMap = {};
    for (var i = 0; i < cachedWords.length; i++) {
      wordMap[cachedWords[i].id] = cachedWords[i];
    }

    for (var m = 0; m < 12; m++) {
      monthLabels.push((m + 1) + '月');
      var mKey = y + '-' + pad2(m + 1);
      var mb = monthBuckets[mKey];

      // 新词学习量 = monthBuckets.newWords 的去重数
      newWordCounts.push(mb ? Object.keys(mb.newWords).length : 0);

      // 平均熟练度 = 该月有学习记录的单词的平均熟练度
      var profSum = 0;
      var profCount = 0;
      if (mb) {
        var wordIds = Object.keys(mb.wordIds);
        for (var j = 0; j < wordIds.length; j++) {
          var w = wordMap[wordIds[j]];
          if (w && w.totalCount > 0) {
            profSum += w.knownCount / w.totalCount;
            profCount++;
          }
        }
      }
      var avgProf = profCount > 0 ? Math.round((profSum / profCount) * 100) : 0;
      avgProficiencies.push(avgProf);
    }

    var ctx = document.getElementById('yearlyChart').getContext('2d');

    // 销毁旧图表
    if (charts.yearly) { charts.yearly.destroy(); }

    charts.yearly = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: monthLabels,
        datasets: [
          {
            type: 'bar',
            label: '新词学习量',
            data: newWordCounts,
            backgroundColor: '#4A90D9',
            borderRadius: 4,
            yAxisID: 'y',
            order: 2,
          },
          {
            type: 'line',
            label: '平均熟练度(%)',
            data: avgProficiencies,
            borderColor: '#F39C12',
            backgroundColor: 'rgba(243,156,18,0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: '#F39C12',
            yAxisID: 'y1',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom' } },
        scales: {
          x: { grid: { display: false } },
          y: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            title: { display: true, text: '新词量' },
            ticks: { precision: 0 },
          },
          y1: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            max: 100,
            title: { display: true, text: '熟练度%' },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function card(value, label, colorClass) {
    return '<div class="stat-card ' + (colorClass || '') + '">' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-label">' + label + '</div>' +
    '</div>';
  }

  /** 紧凑仪表盘单元格 */
  function cell(value, label, colorClass) {
    return '<div class="stat-cell ' + (colorClass || '') + '">' +
      '<span class="stat-cell-num">' + value + '</span>' +
      '<span class="stat-cell-text">' + label + '</span>' +
    '</div>';
  }

  function getMessage(streak, todayCount, accuracy, learned, total, mastered) {
    if (todayCount === 0) return '今天还没有学习，快来背几个单词吧！';
    if (streak >= 30) return '连续学习 ' + streak + ' 天，毅力惊人！你是最棒的！';
    if (streak >= 7) return '连续学习 ' + streak + ' 天，保持这个势头！';
    if (accuracy >= 80 && todayCount > 0) return '今日正确率 ' + accuracy + '%，表现出色！';
    if (accuracy < 50 && todayCount > 5) return '正确率偏低，多复习几遍就会进步，别灰心！';
    if (mastered >= total * 0.5) return '已掌握 ' + mastered + ' 个单词，过半啦！';
    if (learned < total * 0.3) return '词库还有大量新词，每天学一点，积少成多！';
    if (learned >= total * 0.8) return '词库快学完了，胜利在望！';
    return '坚持每天背单词，日积月累见成效！';
  }

  async function renderActivityChart(days) {
    var Chart = await ensureChart();
    var ctx = document.getElementById('activityChart').getContext('2d');
    var labels = days.map(function (d) {
      var date = new Date(d.date);
      return (date.getMonth() + 1) + '/' + date.getDate();
    });

    charts.activity = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: '认识',
            data: days.map(function (d) { return d.known; }),
            backgroundColor: '#27AE60',
            borderRadius: 4,
          },
          {
            label: '不认识',
            data: days.map(function (d) { return d.total - d.known; }),
            backgroundColor: '#E74C3C',
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    });
  }

  async function renderProficiencyChart(dist) {
    var Chart = await ensureChart();
    var ctx = document.getElementById('proficiencyChart').getContext('2d');
    charts.proficiency = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(dist),
        datasets: [{
          data: Object.values(dist),
          backgroundColor: ['#BDC3C9', '#F39C12', '#27AE60'],
          borderWidth: 2,
          borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  return { init: init, show: show };
})();

export default App.Stats;
