/**
 * 海上溢油预测仿真引擎
 * 基于 Lagrangian 粒子追踪法
 *
 * 物理模型包括:
 * 1. 油膜扩展 - Fay 三阶段扩展模型
 * 2. 风漂流 - 风速3%偏转15°
 * 3. 海流输运 - 表层流场驱动
 * 4. 湍流扩散 - 随机游走模型
 * 5. 蒸发 - Stiver-Mackay 蒸发模型
 * 6. 自然分散 - Delvigne-Sweeney 模型
 * 7. 乳化 - Mackay 乳化模型
 * 8. 网格场数据插值 (ERA5 风场 / CMEMS 海流+海温 / 陆海掩膜)
 * 9. 陆地搁浅判定
 */

// 油品物性数据库
const OIL_PROPERTIES = {
  crude: {
    name: '原油',
    density: 860,        // kg/m³
    viscosity: 12,       // mPa·s
    api: 33,
    evapRate: 0.042,     // 蒸发系数
    pourPoint: -15,      // 凝固点 °C
    volatileFrac: 0.25,  // 挥发组分比例
    dispersibility: 0.5
  },
  fuel: {
    name: '燃料油',
    density: 950,
    viscosity: 180,
    api: 17,
    evapRate: 0.015,
    pourPoint: 10,
    volatileFrac: 0.08,
    dispersibility: 0.2
  },
  diesel: {
    name: '柴油',
    density: 840,
    viscosity: 4,
    api: 37,
    evapRate: 0.065,
    pourPoint: -30,
    volatileFrac: 0.45,
    dispersibility: 0.7
  },
  gasoline: {
    name: '汽油',
    density: 740,
    viscosity: 0.6,
    api: 60,
    evapRate: 0.12,
    pourPoint: -60,
    volatileFrac: 0.80,
    dispersibility: 0.9
  }
};

// 常量
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371000; // 地球半径 (m)
const WIND_DRIFT_FACTOR = 0.03; // 风漂系数 3%
const WIND_DEFLECTION = 15 * DEG_TO_RAD; // 风偏角 15°


// ==================== FieldGrid 类 ====================
/**
 * 二维/三维网格场数据容器，支持双线性空间插值 + 线性时间插值
 *
 * JSON 格式:
 * {
 *   lat: [36.0, 36.1, ...],     // 升序纬度
 *   lon: [118.0, 118.1, ...],   // 升序经度
 *   time_hours: [0, 1, ...],    // 时间轴 (可选, 时变场才有)
 *   shape: [nT, nLat, nLon],    // 维度
 *   varName: [v1, v2, ...],     // 展平的 row-major 数组
 * }
 *
 * 索引: data[t * nLat * nLon + latIdx * nLon + lonIdx]
 */
class FieldGrid {
  /**
   * @param {Object} json - 预处理后的 JSON 对象
   */
  constructor(json) {
    this.lat = json.lat;       // Float64Array-like
    this.lon = json.lon;
    this.nLat = this.lat.length;
    this.nLon = this.lon.length;

    // 纬度经度范围
    this.latMin = this.lat[0];
    this.latMax = this.lat[this.nLat - 1];
    this.lonMin = this.lon[0];
    this.lonMax = this.lon[this.nLon - 1];

    // 分辨率（均匀网格假设）
    this.dLat = this.nLat > 1 ? (this.latMax - this.latMin) / (this.nLat - 1) : 1;
    this.dLon = this.nLon > 1 ? (this.lonMax - this.lonMin) / (this.nLon - 1) : 1;

    // 时间轴（可选）
    this.timeHours = json.time_hours || null;
    this.nTime = this.timeHours ? this.timeHours.length : 0;
    this.isTimeVarying = this.nTime > 0;

    // 每个时间步的元素数
    this.sliceSize = this.nLat * this.nLon;

    // 存储各变量的 Float32Array
    this.vars = {};
    const shape = json.shape;
    for (const key of Object.keys(json)) {
      if (['lat', 'lon', 'time_hours', 'shape'].includes(key)) continue;
      const arr = json[key];
      if (Array.isArray(arr) && arr.length > 0) {
        this.vars[key] = new Float32Array(arr);
      }
    }
  }

  /**
   * 判断点是否在网格覆盖域内
   */
  contains(lat, lng) {
    return lat >= this.latMin && lat <= this.latMax &&
           lng >= this.lonMin && lng <= this.lonMax;
  }

  /**
   * 双线性空间插值 + 线性时间插值
   * @param {string} varName - 变量名
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @param {number} [timeHours=0] - 自起始的小时数
   * @returns {number} 插值结果
   */
  sample(varName, lat, lng, timeHours) {
    const data = this.vars[varName];
    if (!data) return 0;

    // 空间索引（clamp 到边界）
    let fi = (lat - this.latMin) / this.dLat;
    let fj = (lng - this.lonMin) / this.dLon;
    fi = Math.max(0, Math.min(fi, this.nLat - 1));
    fj = Math.max(0, Math.min(fj, this.nLon - 1));

    const i0 = Math.min(Math.floor(fi), this.nLat - 2);
    const j0 = Math.min(Math.floor(fj), this.nLon - 2);
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    const di = fi - i0;
    const dj = fj - j0;

    if (!this.isTimeVarying) {
      // 静态场 — 仅空间双线性插值
      const v00 = data[i0 * this.nLon + j0];
      const v01 = data[i0 * this.nLon + j1];
      const v10 = data[i1 * this.nLon + j0];
      const v11 = data[i1 * this.nLon + j1];
      return (1 - di) * (1 - dj) * v00 + (1 - di) * dj * v01 +
             di * (1 - dj) * v10 + di * dj * v11;
    }

    // 时变场 — 时间线性插值 + 空间双线性插值
    const th = timeHours || 0;
    const times = this.timeHours;
    let ft = 0;
    // 定位时间索引
    if (th <= times[0]) {
      ft = 0;
    } else if (th >= times[this.nTime - 1]) {
      ft = this.nTime - 1;
    } else {
      // 线性搜索（时间步不多，通常 < 100）
      for (let k = 0; k < this.nTime - 1; k++) {
        if (th >= times[k] && th <= times[k + 1]) {
          ft = k + (th - times[k]) / (times[k + 1] - times[k]);
          break;
        }
      }
    }

    const t0 = Math.min(Math.floor(ft), this.nTime - 2);
    const t1 = t0 + 1;
    const dt_frac = ft - t0;
    const ss = this.sliceSize;

    // t0 时刻双线性插值
    const off0 = t0 * ss;
    const a00 = data[off0 + i0 * this.nLon + j0];
    const a01 = data[off0 + i0 * this.nLon + j1];
    const a10 = data[off0 + i1 * this.nLon + j0];
    const a11 = data[off0 + i1 * this.nLon + j1];
    const valT0 = (1 - di) * (1 - dj) * a00 + (1 - di) * dj * a01 +
                  di * (1 - dj) * a10 + di * dj * a11;

    // t1 时刻双线性插值
    const off1 = t1 * ss;
    const b00 = data[off1 + i0 * this.nLon + j0];
    const b01 = data[off1 + i0 * this.nLon + j1];
    const b10 = data[off1 + i1 * this.nLon + j0];
    const b11 = data[off1 + i1 * this.nLon + j1];
    const valT1 = (1 - di) * (1 - dj) * b00 + (1 - di) * dj * b01 +
                  di * (1 - dj) * b10 + di * dj * b11;

    // 时间线性插值
    return valT0 * (1 - dt_frac) + valT1 * dt_frac;
  }
}


// ==================== OilParticle ====================
class OilParticle {
  constructor(lat, lng, mass) {
    this.lat = lat;
    this.lng = lng;
    this.mass = mass;         // kg
    this.active = true;       // 是否仍在水面
    this.beached = false;     // 是否搁浅（触岸）
    this.age = 0;             // 粒子年龄 (秒)
    this.thickness = 0.01;    // 初始厚度 (m)
    this.evaporated = 0;      // 蒸发比例
    this.dispersed = 0;       // 分散比例
    this.emulsionWater = 0;   // 乳化含水率
    this.viscosity = 0;       // 当前粘度
  }
}


// ==================== OilSpillSimulation ====================
class OilSpillSimulation {
  constructor() {
    this.particles = [];
    this.time = 0;              // 当前模拟时间 (秒)
    this.timeStep = 600;        // 时间步长 (秒), 默认10分钟
    this.maxTime = 48 * 3600;   // 最大模拟时间 (秒)
    this.isRunning = false;
    this.isPaused = false;
    this.playbackSpeed = 2;

    // 溢油参数
    this.spillLat = 38.5;
    this.spillLng = 119.0;
    this.oilVolume = 500;       // 吨
    this.oilType = 'crude';
    this.particleCount = 1000;
    this.spillMode = 'instant';  // 'instant' | 'continuous'
    this.spillDuration = 12;     // 持续溢油时长 (小时), 仅 continuous 模式
    this._particlesReleased = 0; // 已释放粒子计数

    // 环境参数 (滑块标量值，降级方案)
    this.windSpeed = 5.0;       // m/s
    this.windDir = 180;         // 度 (来向)
    this.currentSpeed = 0.3;    // m/s
    this.currentDir = 90;       // 度 (去向)
    this.waterTemp = 18;        // °C

    // 网格数据 (FieldGrid 对象，null 表示未加载)
    this.windGrid = null;       // ERA5 u10/v10
    this.currentGrid = null;    // CMEMS uo/vo
    this.tempGrid = null;       // CMEMS thetao
    this.landMask = null;       // ERA5-Land lsm
    this.useGridData = true;    // 是否使用网格数据
    this.gridTimeOffset = 0;    // 网格时间偏移 (小时)

    // 统计数据
    this.stats = {
      area: 0,
      remaining: 100,
      evaporated: 0,
      dispersed: 0,
      centerLat: 0,
      centerLng: 0,
      maxDrift: 0,
      beached: 0
    };

    // 历史轨迹
    this.trajectory = [];

    // 回调函数
    this.onUpdate = null;
    this.onComplete = null;

    this._animFrameId = null;
    this._lastFrameTime = 0;
  }

  get oilProps() {
    return OIL_PROPERTIES[this.oilType];
  }

  /**
   * 检查是否有可用的网格数据
   */
  get hasGridData() {
    return !!(this.windGrid || this.currentGrid || this.tempGrid);
  }

  /**
   * 初始化粒子
   */
  initialize() {
    this.particles = [];
    this.time = 0;
    this.trajectory = [];
    this._particlesReleased = 0;
    this.stats = {
      area: 0, remaining: 100, evaporated: 0, dispersed: 0,
      centerLat: this.spillLat, centerLng: this.spillLng, maxDrift: 0, beached: 0
    };

    const massPerParticle = (this.oilVolume * 1000) / this.particleCount; // kg
    const props = this.oilProps;

    if (this.spillMode === 'continuous') {
      // 持续溢油模式：预分配所有粒子但标记为未激活，后续在 _step 中逐步释放
      for (let i = 0; i < this.particleCount; i++) {
        const p = new OilParticle(this.spillLat, this.spillLng, massPerParticle);
        p.viscosity = props.viscosity;
        p.active = false; // 初始未激活
        this.particles.push(p);
      }
    } else {
      // 瞬时溢油模式：一次性释放全部粒子
      const initRadius = 0.002; // 约200m范围
      for (let i = 0; i < this.particleCount; i++) {
        const angle = Math.random() * 2 * Math.PI;
        const r = Math.sqrt(Math.random()) * initRadius;
        const lat = this.spillLat + r * Math.cos(angle);
        const lng = this.spillLng + r * Math.sin(angle) / Math.cos(this.spillLat * DEG_TO_RAD);

        const p = new OilParticle(lat, lng, massPerParticle);
        p.viscosity = props.viscosity;
        this.particles.push(p);
      }
      this._particlesReleased = this.particleCount;
    }
  }

  /**
   * 开始模拟
   */
  start() {
    if (this.particles.length === 0) {
      this.initialize();
    }
    this.isRunning = true;
    this.isPaused = false;
    this._lastFrameTime = performance.now();
    this._tick();
  }

  /**
   * 暂停模拟
   */
  pause() {
    this.isPaused = !this.isPaused;
    if (!this.isPaused) {
      this._lastFrameTime = performance.now();
      this._tick();
    }
  }

  /**
   * 重置模拟
   */
  reset() {
    this.isRunning = false;
    this.isPaused = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
    }
    this.particles = [];
    this.time = 0;
    this.trajectory = [];
    this._particlesReleased = 0;
    this.stats = {
      area: 0, remaining: 100, evaporated: 0, dispersed: 0,
      centerLat: this.spillLat, centerLng: this.spillLng, maxDrift: 0, beached: 0
    };
  }

  /**
   * 主循环
   */
  _tick() {
    if (!this.isRunning || this.isPaused) return;

    const now = performance.now();
    const elapsed = now - this._lastFrameTime;

    // 根据播放速度控制更新频率
    const targetInterval = 50; // 50ms per frame
    if (elapsed < targetInterval) {
      this._animFrameId = requestAnimationFrame(() => this._tick());
      return;
    }

    this._lastFrameTime = now;

    // 每帧推进一个时间步长 * 播放速度
    for (let s = 0; s < this.playbackSpeed; s++) {
      if (this.time >= this.maxTime) {
        this.isRunning = false;
        if (this.onComplete) this.onComplete();
        return;
      }
      this._step();
    }

    // 更新统计和回调
    this._updateStats();
    if (this.onUpdate) this.onUpdate(this.particles, this.stats, this.time);

    this._animFrameId = requestAnimationFrame(() => this._tick());
  }

  /**
   * 单步推进 — 核心物理计算
   * 当 useGridData 开启且有网格数据时，逐粒子在网格上插值获取局部环境场；
   * 否则退回全局均匀标量（滑块值）模式。
   */
  _step() {
    const dt = this.timeStep;
    const props = this.oilProps;
    const useGrid = this.useGridData && this.hasGridData;
    const gridT = (this.time / 3600) + this.gridTimeOffset; // 网格时间 (小时)

    // ---- 持续溢油：逐步释放新粒子 ----
    if (this.spillMode === 'continuous' && this._particlesReleased < this.particleCount) {
      const spillDurSec = this.spillDuration * 3600;
      if (this.time < spillDurSec) {
        const targetReleased = Math.min(
          Math.floor((this.time + dt) / spillDurSec * this.particleCount),
          this.particleCount
        );
        const toRelease = targetReleased - this._particlesReleased;
        const initRadius = 0.001;
        for (let i = 0; i < toRelease && this._particlesReleased < this.particleCount; i++) {
          const p = this.particles[this._particlesReleased];
          const angle = Math.random() * 2 * Math.PI;
          const r = Math.sqrt(Math.random()) * initRadius;
          p.lat = this.spillLat + r * Math.cos(angle);
          p.lng = this.spillLng + r * Math.sin(angle) / Math.cos(this.spillLat * DEG_TO_RAD);
          p.active = true;
          p.age = 0;
          this._particlesReleased++;
        }
      }
    }

    // ---- 全局风化参数（不依赖位置） ----
    const hoursElapsed = this.time / 3600;

    // ---- 如果不使用网格，预计算全局漂移向量（向后兼容） ----
    let globalTotalU = 0, globalTotalV = 0, globalDiffCoeff = 1.0, globalWs = this.windSpeed;
    if (!useGrid) {
      const timeVariation = Math.sin(this.time * 0.0002) * 0.1;
      const ws = this.windSpeed * (1 + timeVariation);
      const wd = this.windDir + 5 * Math.sin(this.time * 0.0003);
      const cs = this.currentSpeed * (1 + 0.05 * Math.sin(this.time * 0.0005));
      const cd = this.currentDir + 3 * Math.cos(this.time * 0.0004);
      globalWs = ws;

      const windGoRad = ((wd + 180) % 360) * DEG_TO_RAD;
      const currentGoRad = cd * DEG_TO_RAD;

      const windDriftU = ws * WIND_DRIFT_FACTOR * Math.sin(windGoRad + WIND_DEFLECTION);
      const windDriftV = ws * WIND_DRIFT_FACTOR * Math.cos(windGoRad + WIND_DEFLECTION);
      const currentU = cs * Math.sin(currentGoRad);
      const currentV = cs * Math.cos(currentGoRad);

      globalTotalU = windDriftU + currentU;
      globalTotalV = windDriftV + currentV;
      globalDiffCoeff = 1.0 + 0.5 * ws;
    }

    // 风化（简化：取全局代表值）
    const repWs = useGrid ? 5.0 : globalWs; // 网格模式下用典型风速
    const evapFraction = this._calcEvaporation(props, hoursElapsed, this.waterTemp, repWs);
    const dispersFraction = this._calcDispersion(props, repWs, hoursElapsed);
    const emulsionWater = this._calcEmulsion(hoursElapsed, repWs);

    // ---- 逐粒子循环 ----
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      p.age += dt;

      // 风化
      p.evaporated = Math.min(evapFraction, props.volatileFrac);
      p.dispersed = Math.min(dispersFraction, 0.3);
      p.emulsionWater = emulsionWater;

      const viscMult = Math.exp(5 * p.evaporated) * (1 / Math.pow(1 - p.emulsionWater, 2.5));
      p.viscosity = props.viscosity * viscMult;

      const remainFrac = 1 - p.evaporated - p.dispersed;
      if (remainFrac < 0.05) {
        p.active = false;
        continue;
      }
      p.mass = ((this.oilVolume * 1000) / this.particleCount) * remainFrac;

      // Fay 扩展
      const tHours = p.age / 3600;
      if (tHours > 0) {
        p.thickness = 0.01 * Math.pow(tHours, -0.33);
      }

      // ---- 计算漂移向量 ----
      let totalU, totalV, diffCoeff;

      if (useGrid) {
        // === 网格模式：逐粒子在当前位置插值 ===
        let u10 = 0, v10 = 0, uo = 0, vo = 0;

        // 风场 (ERA5: u10/v10 直接是东/北向分量, m/s)
        if (this.windGrid && this.windGrid.contains(p.lat, p.lng)) {
          u10 = this.windGrid.sample('u10', p.lat, p.lng, gridT);
          v10 = this.windGrid.sample('v10', p.lat, p.lng, gridT);
        }

        // 海流 (CMEMS: uo/vo 直接是东/北向分量, m/s)
        if (this.currentGrid && this.currentGrid.contains(p.lat, p.lng)) {
          uo = this.currentGrid.sample('uo', p.lat, p.lng, gridT);
          vo = this.currentGrid.sample('vo', p.lat, p.lng, gridT);
        }

        // 海温 (CMEMS: thetao, °C) — 用于风化计算
        if (this.tempGrid && this.tempGrid.contains(p.lat, p.lng)) {
          // 可用于更精确的蒸发计算（此处简化处理）
          // const localTemp = this.tempGrid.sample('thetao', p.lat, p.lng, gridT);
        }

        // 风漂流 = 3% 风速, 偏转15°
        const windSpeed = Math.sqrt(u10 * u10 + v10 * v10);
        const windAngle = Math.atan2(u10, v10); // 风吹去的方向
        const driftU = windSpeed * WIND_DRIFT_FACTOR * Math.sin(windAngle + WIND_DEFLECTION);
        const driftV = windSpeed * WIND_DRIFT_FACTOR * Math.cos(windAngle + WIND_DEFLECTION);

        totalU = driftU + uo;  // 东向 (m/s)
        totalV = driftV + vo;  // 北向 (m/s)
        diffCoeff = 1.0 + 0.5 * windSpeed;
      } else {
        // === 均匀场模式（滑块标量） ===
        totalU = globalTotalU;
        totalV = globalTotalV;
        diffCoeff = globalDiffCoeff;
      }

      // 随机扩散 (Box-Muller)
      const randomU = this._gaussRandom() * Math.sqrt(2 * diffCoeff * dt);
      const randomV = this._gaussRandom() * Math.sqrt(2 * diffCoeff * dt);

      const du = totalU * dt + randomU; // 米
      const dv = totalV * dt + randomV; // 米

      // 转换为经纬度增量
      const dLat = (dv / EARTH_RADIUS) * RAD_TO_DEG;
      const dLng = (du / (EARTH_RADIUS * Math.cos(p.lat * DEG_TO_RAD))) * RAD_TO_DEG;

      p.lat += dLat;
      p.lng += dLng;

      // ---- 陆海掩膜：搁浅判定 ----
      if (this.landMask && this.landMask.contains(p.lat, p.lng)) {
        const lsm = this.landMask.sample('lsm', p.lat, p.lng);
        if (lsm > 0.5) {
          // 搁浅：回退位移，标记为搁浅
          p.lat -= dLat;
          p.lng -= dLng;
          p.active = false;
          p.beached = true;
        }
      }
    }

    this.time += dt;

    // 每小时记录轨迹
    if (this.time % 3600 < dt) {
      const active = this.particles.filter(p => p.active);
      if (active.length > 0) {
        const cLat = active.reduce((s, p) => s + p.lat, 0) / active.length;
        const cLng = active.reduce((s, p) => s + p.lng, 0) / active.length;
        this.trajectory.push({ time: this.time, lat: cLat, lng: cLng });
      }
    }
  }

  /**
   * Stiver-Mackay 蒸发模型 (简化)
   */
  _calcEvaporation(props, hours, temp, windSpeed) {
    if (hours <= 0) return 0;
    const K = props.evapRate * (1 + 0.045 * (temp - 15));
    const evapFrac = K * Math.sqrt(hours) * (1 + 0.01 * windSpeed);
    return Math.min(evapFrac, props.volatileFrac);
  }

  /**
   * Delvigne-Sweeney 自然分散模型 (简化)
   */
  _calcDispersion(props, windSpeed, hours) {
    if (hours <= 0 || windSpeed < 5) return 0;
    const Dba = 0.0034 * props.dispersibility;
    const waveEnergy = Math.pow(windSpeed, 2) * 0.001;
    const dispRate = Dba * waveEnergy;
    return Math.min(dispRate * hours, 0.3);
  }

  /**
   * Mackay 乳化模型 (简化)
   */
  _calcEmulsion(hours, windSpeed) {
    if (hours <= 0 || windSpeed < 3) return 0;
    const Ymax = 0.7;
    const Ka = 2e-6 * Math.pow(windSpeed + 1, 2);
    const Y = Ymax * (1 - Math.exp(-Ka * hours * 3600));
    return Math.min(Y, Ymax);
  }

  /**
   * 更新统计信息
   */
  _updateStats() {
    const active = this.particles.filter(p => p.active);
    const beachedCount = this.particles.filter(p => p.beached).length;

    if (active.length === 0 && beachedCount === 0) return;

    // 搁浅统计
    this.stats.beached = beachedCount;

    if (active.length === 0) return;

    // 质心
    const cLat = active.reduce((s, p) => s + p.lat, 0) / active.length;
    const cLng = active.reduce((s, p) => s + p.lng, 0) / active.length;

    // 扩散面积
    const latStd = Math.sqrt(active.reduce((s, p) => s + Math.pow(p.lat - cLat, 2), 0) / active.length);
    const lngStd = Math.sqrt(active.reduce((s, p) => s + Math.pow(p.lng - cLng, 2), 0) / active.length);
    const latKm = latStd * 111.32;
    const lngKm = lngStd * 111.32 * Math.cos(cLat * DEG_TO_RAD);
    const area = Math.PI * latKm * lngKm * 4;

    // 最远漂移距离
    const maxDrift = active.reduce((m, p) => {
      const d = this._haversineDistance(this.spillLat, this.spillLng, p.lat, p.lng);
      return Math.max(m, d);
    }, 0);

    // 风化
    const rep = active[0];

    this.stats = {
      area: area,
      remaining: (1 - rep.evaporated - rep.dispersed) * 100,
      evaporated: rep.evaporated * 100,
      dispersed: rep.dispersed * 100,
      centerLat: cLat,
      centerLng: cLng,
      maxDrift: maxDrift / 1000,
      emulsionWater: rep.emulsionWater * 100,
      viscosity: rep.viscosity,
      beached: beachedCount
    };
  }

  /**
   * Haversine 距离公式
   */
  _haversineDistance(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLng = (lng2 - lng1) * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
              Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Box-Muller 高斯随机数
   */
  _gaussRandom() {
    let u, v, s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  }
}

// 导出
window.OilSpillSimulation = OilSpillSimulation;
window.OIL_PROPERTIES = OIL_PROPERTIES;
window.FieldGrid = FieldGrid;
