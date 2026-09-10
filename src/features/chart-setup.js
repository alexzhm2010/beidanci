/**
 * Chart.js 按需注册包装模块 (v1.11.1 性能优化)
 *
 * 作用:
 *   - 用静态 named import 让 Rollup tree-shake 掉未使用的 Chart.js 控制器
 *   - 替代 `import('chart.js/auto')` (后者注册全部 ~14 个控制器, 体积 207KB)
 *   - stats.js / admin.js 共用本模块, 一次注册, 多处复用
 *
 * 注册内容:
 *   - BarController  (stats 近7天/年度看板, admin 用户增长)
 *   - LineController (admin 趋势)
 *   - DoughnutController (stats 熟练度饼图, admin 用户分布)
 *   - CategoryScale + LinearScale (Bar/Line 必需的坐标轴)
 *   - Tooltip + Legend + Title (通用插件)
 *
 * 预期体积: chart.js chunk 从 207KB → ~120KB raw / 71KB → ~40KB gzip
 */
import {
  Chart,
  CategoryScale,
  LinearScale,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  Tooltip,
  Legend,
  Title,
} from 'chart.js';

// 仅注册一次 (模块级单例, 多次 import 本模块只执行一次)
Chart.register(
  CategoryScale,
  LinearScale,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  Tooltip,
  Legend,
  Title
);

export default Chart;
