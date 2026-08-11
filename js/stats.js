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

  function init() {
    // 统计模块无需绑定事件, 每次 show() 时刷新
  }

  async function show() {
    try {
      // 1. 拉取单词数据 (显式不传 limit → db.js 会用大值, 避免 1000 截断)
      var learnedWords = await App.DB.getLearnedWords();

      // 获取精确计数: 词库总数, 已学数 (已学=learnedWords.length, 因为 total_count>0)
      var total = 0;
      try { total = await App.DB.getWordCount(); } catch (e) {}
      var learned = learnedWords.length;
      var newCount = total - learned;
      if (newCount < 0) newCount = 0;
      var mastered = learnedWords.filter(function (w) {
        return w.totalCount && w.totalCount > 0 && w.knownCount / w.totalCount >= 0.85;
      }).length;

      var words = learnedWords;
      var wordCounts = [total, newCount, learned, mastered];

      // 2. 拉取学习记录 (拉取2年数据供日历和年度看板使用, db.js 内部已用大 limit 避免截断)
      var records = [];
      try {
        var twoYearsAgo = Date.now() - 730 * 24 * 60 * 60 * 1000;
        records = await App.DB.getRecords(twoYearsAgo);
      } catch (e) {
        console.error('加载学习记录失败:', e);
      }

      cachedWords = words;
      cachedRecords = records;

      // 初始化日历状态为当月
      var now = new Date();
      calendarState = { year: now.getFullYear(), month: now.getMonth() };
      yearlyState = { year: now.getFullYear() };

      render(words, records, wordCounts);
    } catch (e) {
      document.getElementById('statsContent').innerHTML =
        '<div class="stats-empty"><h3>加载失败</h3><p>' + App.Utils.escapeHtml(e.message) + '</p></div>';
    }
  }

  function render(words, records, wordCounts) {
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

    // ---- 计算统计数据 ----
    var dueNow = App.Algorithm.getDueCount(words);
    var upcoming24h = App.Algorithm.getUpcomingCount(words, 24);

    // 今日
    var todayStart = App.Utils.todayStart();
    var todayRecords = records.filter(function (r) { return r.timestamp >= todayStart; });
    var todayCount = todayRecords.length;
    var todayKnown = todayRecords.filter(function (r) { return r.isKnown; }).length;
    var todayAccuracy = todayCount > 0 ? Math.round((todayKnown / todayCount) * 100) : 0;

    // 近7天
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var dStart = App.Utils.daysAgoStart(i);
      var dEnd = dStart + 86400000;
      var dayRecs = records.filter(function (r) { return r.timestamp >= dStart && r.timestamp < dEnd; });
      days.push({
        date: dStart,
        total: dayRecs.length,
        known: dayRecs.filter(function (r) { return r.isKnown; }).length,
      });
    }

    // 连续天数
    var streak = 0;
    for (var i2 = 0; i2 < 365; i2++) {
      var dStart2 = App.Utils.daysAgoStart(i2);
      var dEnd2 = dStart2 + 86400000;
      var hasActivity = records.some(function (r) { return r.timestamp >= dStart2 && r.timestamp < dEnd2; });
      if (hasActivity) streak++;
      else if (i2 > 0) break;
    }

    // 熟练度分布
    var dist = {
      '未学习': newCount,
      '已学习': learned - mastered,
      '已掌握': mastered,
    };

    // 本周新词
    var weekStart = App.Utils.daysAgoStart(6);
    var weekNewWords = records.filter(function (r) {
      return r.timestamp >= weekStart && r.sessionType === 'new';
    }).length;

    // 总体正确率
    var totalKnown = records.filter(function (r) { return r.isKnown; }).length;
    var overallAccuracy = records.length > 0 ? Math.round((totalKnown / records.length) * 100) : 0;

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

    // 按天统计学习记录数
    var dayCounts = {};
    for (var d = 1; d <= daysInMonth; d++) {
      var dayStart = new Date(y, m, d, 0, 0, 0, 0).getTime();
      var dayEnd = dayStart + 86400000;
      var count = cachedRecords.filter(function (r) {
        return r.timestamp >= dayStart && r.timestamp < dayEnd;
      }).length;
      dayCounts[d] = count;
    }

    // 构建日历HTML
    var html =
      '<div class="calendar-nav">' +
        '<button class="btn btn-sm btn-outline" id="btnPrevMonth">&lt;</button>' +
        '<span class="calendar-title">' + y + '年 ' + monthNames[m] + '</span>' +
        '<button class="btn btn-sm btn-outline" id="btnNextMonth">&gt;</button>' +
      '</div>' +
      '<div class="calendar-legend">' +
        '<span class="legend-item"><span class="medal medal-gold">🥇</span>≥200</span>' +
        '<span class="legend-item"><span class="medal medal-silver">🥈</span>≥150</span>' +
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

      if (count >= 200) { medal = '🥇'; medalClass = 'has-medal gold'; }
      else if (count >= 150) { medal = '🥈'; medalClass = 'has-medal silver'; }
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
    // 统计当月数据
    var monthStart = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    var monthEnd = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();

    var monthRecords = cachedRecords.filter(function (r) {
      return r.timestamp >= monthStart && r.timestamp < monthEnd;
    });
    var monthTotal = monthRecords.length;
    var monthKnown = monthRecords.filter(function (r) { return r.isKnown; }).length;
    // 月度「新学词」= 当月 sessionType=new 的去重单词数
    var monthNewSet = {};
    monthRecords.forEach(function (r) {
      if (r.sessionType === 'new' && r.wordId) monthNewSet[r.wordId] = true;
    });
    var monthNewWords = Object.keys(monthNewSet).length;
    var monthAccuracy = monthTotal > 0 ? Math.round((monthKnown / monthTotal) * 100) : 0;

    // 活跃天数
    var activeDays = 0;
    var goldDays = 0, silverDays = 0, bronzeDays = 0;
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var c = dayCounts[d] || 0;
      if (c > 0) activeDays++;
      if (c >= 200) goldDays++;
      else if (c >= 150) silverDays++;
      else if (c >= 100) bronzeDays++;
    }

    // 当月新学单词数 (首次学习发生在本月的去重单词)
    var monthLearnedWords = 0;
    var monthMasteredWords = 0;
    cachedWords.forEach(function (w) {
      if (w.lastLearnTime && w.lastLearnTime >= monthStart && w.lastLearnTime < monthEnd) {
        monthLearnedWords++;
      }
      if (w.lastKnownTime && w.lastKnownTime >= monthStart && w.lastKnownTime < monthEnd) {
        if (w.totalCount > 0 && w.knownCount / w.totalCount >= 0.85) {
          monthMasteredWords++;
        }
      }
    });

    // 熟练度分布
    var prof0_40 = 0, prof40_60 = 0, prof60_80 = 0, prof80_100 = 0;
    cachedWords.forEach(function (w) {
      if (!w.totalCount || w.totalCount === 0) return;
      var p = w.knownCount / w.totalCount;
      if (p < 0.4) prof0_40++;
      else if (p < 0.6) prof40_60++;
      else if (p < 0.8) prof60_80++;
      else prof80_100++;
    });

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

  function renderYearlyChart() {
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

    for (var m = 0; m < 12; m++) {
      monthLabels.push((m + 1) + '月');
      var monthStart = new Date(y, m, 1, 0, 0, 0, 0).getTime();
      var monthEnd = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();

      // 该月新学单词数 = sessionType=new 的去重单词数
      var monthNewSet = {};
      cachedRecords.forEach(function (r) {
        if (r.timestamp >= monthStart && r.timestamp < monthEnd && r.sessionType === 'new' && r.wordId) {
          monthNewSet[r.wordId] = true;
        }
      });
      newWordCounts.push(Object.keys(monthNewSet).length);

      // 该月平均熟练度 (该月有学习记录的单词的平均熟练度)
      var monthWordIds = {};
      cachedRecords.forEach(function (r) {
        if (r.timestamp >= monthStart && r.timestamp < monthEnd && r.wordId) {
          monthWordIds[r.wordId] = true;
        }
      });
      var profSum = 0;
      var profCount = 0;
      cachedWords.forEach(function (w) {
        if (monthWordIds[w.id] && w.totalCount > 0) {
          profSum += w.knownCount / w.totalCount;
          profCount++;
        }
      });
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

  function renderActivityChart(days) {
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

  function renderProficiencyChart(dist) {
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
