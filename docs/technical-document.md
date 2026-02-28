# 海上溢油预测仿真系统 — 技术文档

## 1. 系统架构

### 1.1 总体架构

采用 B/S（Browser/Server）架构，前端运行全部仿真计算（Lagrangian 粒子追踪），服务端仅负责静态文件托管与网格数据 API。

```
┌─────────────────────────────────────────────────────────┐
│  浏览器 (Client)                                         │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ index.html   │  │ simulation.js │  │   app.js     │  │
│  │  UI / DOM    │  │  FieldGrid    │  │  Leaflet Map │  │
│  │  控件 / 图例  │  │  粒子追踪引擎  │  │  Canvas 渲染  │  │
│  └──────────────┘  └───────────────┘  └──────────────┘  │
│         ↕ DOM                 ↕ onUpdate 回调             │
│  ┌──────────────────────────────────────────────────────┐│
│  │             requestAnimationFrame 主循环              ││
│  └──────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP (fetch)
┌──────────────────────────┴──────────────────────────────┐
│  服务器 (Python http.server, port 3000)                  │
│  ├─ GET /               → public/ 静态文件                │
│  ├─ GET /api/grid-status → 网格数据可用性 JSON             │
│  └─ GET /api/grid/{name} → 网格 JSON (支持 gzip)          │
│                                                          │
│  data/processed/                                         │
│  ├─ wind_grid.json        (1142 KB)                      │
│  ├─ current_grid.json     ( 937 KB)                      │
│  ├─ temperature_grid.json ( 424 KB)                      │
│  └─ landmask_grid.json    (  12 KB)                      │
└──────────────────────────────────────────────────────────┘
```

### 1.2 文件结构

```
oil-spill-simulation/
├── server.py                   # Python HTTP 服务器
├── public/
│   ├── index.html              # 主页面
│   ├── css/style.css           # 样式表
│   └── js/
│       ├── simulation.js       # 核心仿真引擎 (FieldGrid + OilParticle + OilSpillSimulation)
│       └── app.js              # 前端控制器 (地图、UI、Canvas 渲染、网格加载)
├── data/
│   ├── download_cmems.py       # CMEMS 海流/海温下载脚本
│   ├── download_era5_wind.py   # ERA5 风场下载脚本
│   ├── download_landmask.py    # ERA5-Land 陆海掩膜下载脚本
│   ├── preprocess.py           # NetCDF → JSON 预处理
│   ├── raw/                    # 原始 NetCDF 数据
│   │   ├── cmems_currents.nc
│   │   ├── cmems_sst.nc
│   │   ├── era5_wind.nc
│   │   └── era5_landmask.nc
│   └── processed/              # 预处理后 JSON 网格
│       ├── wind_grid.json
│       ├── current_grid.json
│       ├── temperature_grid.json
│       └── landmask_grid.json
└── docs/
    └── technical-document.md   # 本文档
```

---

## 2. 真实数据源

### 2.1 数据概览

| 数据集 | 来源 | 产品 ID | 变量 | 空间分辨率 | 时间分辨率 |
|--------|------|---------|------|-----------|-----------|
| 10m 风场 | ECMWF ERA5 Single Levels | `reanalysis-era5-single-levels` | u10, v10 | 0.25° | 逐小时 |
| 表层海流 | Copernicus CMEMS | `cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i` | uo, vo | 0.083° (1/12°) | 6 小时 |
| 海表温度 | Copernicus CMEMS | `cmems_mod_glo_phy-thetao_anfc_0.083deg_PT6H-i` | thetao | 0.083° | 6 小时 |
| 陆海掩膜 | ECMWF ERA5-Land | `reanalysis-era5-land` | lsm | 0.1° | 静态 |

### 2.2 数据范围

- **空间范围**: 36°N–40°N, 118°E–124°E（渤海/黄海海域）
- **时间范围**: 2024-01-15 00:00 UTC — 2024-01-17 00:00 UTC（48 小时）
- **深度**: 表层 ~0.49 m（CMEMS 最浅层）

### 2.3 数据下载方式

- **CMEMS**: 使用 `copernicusmarine` Python 包调用 `subset()` API，凭据存储在 `~/.copernicusmarine/`
- **ERA5**: 使用 `cdsapi` Python 包提交请求，凭据存储在 `~/.cdsapirc`

### 2.4 预处理流程 (preprocess.py)

NetCDF → JSON 转换步骤：

1. 使用 `xarray` 加载 `.nc` 文件
2. 统一坐标命名（`latitude/lat`、`longitude/lon`）
3. 确保纬度升序排列（降序则翻转）
4. 若有深度维度则挤压取表层
5. 将 NaN 替换为 0（掩膜中 NaN 替换为 1.0 视为陆地）
6. 时变场提取时间轴，转换为自起始时刻的小时数
7. 数值保留 3 位小数，数组展平为 row-major 一维数组
8. 输出紧凑 JSON（无空格分隔符）

**JSON 格式**:

```json
{
  "lat": [36.0, 36.083, ...],
  "lon": [118.0, 118.083, ...],
  "time_hours": [0, 6, 12, 18, 24, 30, 36, 42, 48],
  "shape": [9, 49, 73],
  "uo": [0.123, -0.045, ...],
  "vo": [0.087, 0.234, ...]
}
```

**索引公式**: `data[t * nLat * nLon + lat_i * nLon + lon_i]`

---

## 3. 核心算法

### 3.1 方法论: Lagrangian 粒子追踪

将溢油离散化为 N 个粒子（默认 1000），每个粒子代表 `M_total / N` 千克油。每个时间步长 Δt（默认 600 秒 = 10 分钟），对每个活跃粒子执行：

```
新位置 = 当前位置 + 风漂流位移 + 海流位移 + 湍流扩散位移
```

实现位于 `simulation.js` 的 `OilSpillSimulation._step()` 方法。

### 3.2 粒子初始化

#### 瞬时溢油模式 (instant)

所有粒子在 t=0 时刻一次性释放，均匀分布在以溢油点为圆心、半径约 200m 的圆形区域内：

```javascript
const angle = Math.random() * 2 * Math.PI;
const r = Math.sqrt(Math.random()) * 0.002;  // ~200m (经纬度)
lat = spillLat + r * cos(angle);
lng = spillLng + r * sin(angle) / cos(spillLat * π/180);
```

> `Math.sqrt(Math.random())` 确保面积上均匀分布（极坐标面元 r·dr·dθ 补偿）。

#### 持续溢油模式 (continuous)

预分配所有粒子（`active = false`），在 `_step()` 中根据已流逝时间线性释放：

```
targetReleased = floor((time + dt) / spillDuration_sec * N)
```

每步释放 `targetReleased - _particlesReleased` 个粒子，在溢油源附近 ~100m 范围随机初始化。

### 3.3 风漂流模型

#### 3.3.1 物理模型

油膜受风拖曳，表面漂流速度约为风速的 3%，并受 Coriolis 效应（Ekman 偏转）影响向右偏转约 15°（北半球）：

$$
\vec{V}_{wind\_drift} = 0.03 \cdot W \cdot \hat{e}(\theta_{wind} + 15°)
$$

其中 W 为风速（m/s），θ_wind 为风吹去的方向。

#### 3.3.2 网格模式实现

ERA5 提供东向分量 u10 和北向分量 v10（m/s），直接是分量形式：

```javascript
// 在粒子位置插值获取风分量
u10 = windGrid.sample('u10', p.lat, p.lng, gridT);
v10 = windGrid.sample('v10', p.lat, p.lng, gridT);

// 风速和风向
windSpeed = sqrt(u10² + v10²);
windAngle = atan2(u10, v10);  // 风吹去的方向

// 风漂流 = 3% * 风速, 偏转 15°
driftU = windSpeed * 0.03 * sin(windAngle + 15°);
driftV = windSpeed * 0.03 * cos(windAngle + 15°);
```

#### 3.3.3 均匀场模式实现（降级方案）

当无网格数据时，使用滑块设定的全局标量值，叠加微弱时间扰动模拟波动：

```javascript
ws = windSpeed * (1 + 0.1 * sin(time * 0.0002));  // ±10% 波动
wd = windDir + 5 * sin(time * 0.0003);            // ±5° 摆动
```

> 风向约定：滑块值为"风来的方向"（气象惯例），代码中转换为"风去的方向"时加 180°。

### 3.4 海流输运

#### 3.4.1 网格模式

CMEMS 提供东向流速 uo 和北向流速 vo（m/s），直接叠加：

```javascript
uo = currentGrid.sample('uo', p.lat, p.lng, gridT);
vo = currentGrid.sample('vo', p.lat, p.lng, gridT);
totalU = driftU + uo;  // 东向总速度
totalV = driftV + vo;  // 北向总速度
```

#### 3.4.2 均匀场模式

```javascript
cs = currentSpeed * (1 + 0.05 * sin(time * 0.0005));
cd = currentDir + 3 * cos(time * 0.0004);
currentU = cs * sin(cd_rad);
currentV = cs * cos(cd_rad);
```

> 流向约定：滑块值为"流去的方向"（海洋学惯例），无需转换。

### 3.5 湍流扩散 — 随机游走模型

模拟次网格尺度湍流混合效应。每个粒子在每个时间步叠加高斯随机位移：

$$
\delta x_{turb} = \mathcal{N}(0,1) \cdot \sqrt{2 D \cdot \Delta t}
$$

其中 D 为湍流扩散系数（m²/s），本系统采用简化参数化：

```javascript
D = 1.0 + 0.5 * windSpeed;  // m²/s, 风越大扩散越强
```

高斯随机数通过 **Box-Muller** 变换生成：

```javascript
_gaussRandom() {
  let u, v, s;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}
```

### 3.6 位移坐标转换

将米制位移转换为经纬度增量（球面近似）：

```javascript
dLat = (dv / R_earth) * (180 / π);
dLng = (du / (R_earth * cos(lat * π/180))) * (180 / π);
```

其中 R_earth = 6,371,000 m。经度增量随纬度 cos 补偿，确保高纬度地区不产生经度畸变。

### 3.7 陆地搁浅判定

每步位移后检查陆海掩膜：

```javascript
if (landMask.contains(p.lat, p.lng)) {
  lsm = landMask.sample('lsm', p.lat, p.lng);
  if (lsm > 0.5) {
    // 搁浅: 回退位移, 标记 beached
    p.lat -= dLat;
    p.lng -= dLng;
    p.active = false;
    p.beached = true;
  }
}
```

- ERA5-Land 掩膜值: 0 = 海洋, 1 = 陆地
- 阈值 0.5 用于处理海岸线附近的混合像元
- 搁浅粒子回退到前一时刻位置，不再参与漂移计算，但仍在地图上显示（灰色）

---

## 4. 风化过程模型

### 4.1 蒸发 — Stiver-Mackay 模型 (简化)

```javascript
_calcEvaporation(props, hours, temp, windSpeed) {
  K = evapRate * (1 + 0.045 * (temp - 15));     // 温度修正蒸发系数
  F_evap = K * sqrt(hours) * (1 + 0.01 * windSpeed); // 蒸发比例
  return min(F_evap, volatileFrac);               // 不超过挥发组分上限
}
```

**物理含义**:
- 蒸发速率与时间平方根成正比（扩散控制）
- 温度每升高 1°C，蒸发速率增加约 4.5%
- 风速促进蒸发（强化界面传质）
- 蒸发上限由油品挥发组分比例决定（原油 25%，汽油 80%）

### 4.2 自然分散 — Delvigne-Sweeney 模型 (简化)

```javascript
_calcDispersion(props, windSpeed, hours) {
  if (windSpeed < 5) return 0;                   // 风速<5 m/s 不发生显著分散
  Dba = 0.0034 * dispersibility;                  // 分散基准率
  waveEnergy = windSpeed² * 0.001;                // 波浪能参数化
  dispRate = Dba * waveEnergy;                    // 分散速率
  return min(dispRate * hours, 0.3);              // 上限 30%
}
```

**物理含义**:
- 风速 > 5 m/s 时波浪破碎开始将油滴卷入水柱
- 分散率与波浪能（~风速²）成正比
- 油品分散性系数影响基准率（柴油 0.7 > 原油 0.5 > 燃料油 0.2）

### 4.3 乳化 — Mackay 模型 (简化)

```javascript
_calcEmulsion(hours, windSpeed) {
  if (windSpeed < 3) return 0;                    // 风速<3 m/s 不发生乳化
  Ymax = 0.7;                                     // 最大含水率 70%
  Ka = 2e-6 * (windSpeed + 1)²;                   // 吸水速率常数
  Y = Ymax * (1 - exp(-Ka * hours * 3600));       // 含水率随时间趋近 Ymax
  return min(Y, Ymax);
}
```

**物理含义**:
- 油膜在波浪搅拌下形成油包水乳液
- 含水率指数增长趋近最大值（典型为 70%）
- 风越大乳化越快

### 4.4 粘度变化

蒸发和乳化共同导致粘度急剧增大：

```javascript
viscMult = exp(5 * F_evap) * (1 / (1 - Y_water)^2.5);
currentViscosity = baseViscosity * viscMult;
```

- **蒸发效应**: 轻组分蒸发后重组分浓度增大，粘度指数增长（Mooney 公式）
- **乳化效应**: 含水率增大使乳液粘度按 Richardson 公式增长
- 典型变化: 原油初始 12 mPa·s → 48h 后可达 ~850 mPa·s

### 4.5 油膜厚度 — Fay 三阶段扩展 (简化)

```javascript
thickness = 0.01 * (t_hours)^(-0.33);  // 初始 10mm, 随时间减薄
```

- 重力-粘性扩展阶段的幂律衰减（指数 -1/3）
- 油膜初始厚度约 10mm，48 小时后约 2.7mm
- 厚度决定粒子在地图上的颜色深浅

### 4.6 粒子失活

当粒子残留比例低于 5% 时标记失活：

```javascript
remainFrac = 1 - evaporated - dispersed;
if (remainFrac < 0.05) { p.active = false; }
```

---

## 5. 网格场数据插值 — FieldGrid 类

### 5.1 数据存储

网格数据以 `Float32Array` 存储于客户端内存，索引方式：

```
index = t * nLat * nLon + lat_i * nLon + lon_i
```

### 5.2 双线性空间插值

给定查询点 (lat, lng)，计算连续索引：

```
fi = (lat - latMin) / dLat    // 纬度连续索引
fj = (lng - lonMin) / dLon    // 经度连续索引
```

Clamp 到 [0, nLat-1] × [0, nLon-1]，取 4 个邻近网格点加权平均：

```
V = (1-di)(1-dj)·V[i0,j0] + (1-di)·dj·V[i0,j1]
  +  di·(1-dj)·V[i1,j0] +  di·dj·V[i1,j1]
```

其中 `di = fi - i0`, `dj = fj - j0`。

### 5.3 线性时间插值

时变场在空间双线性插值后，再在相邻两个时间步之间线性插值：

```
V(t) = V(t0) * (1 - dt_frac) + V(t1) * dt_frac
```

其中 `dt_frac = (t - t0) / (t1 - t0)`。

### 5.4 静态场处理

陆海掩膜为静态场（无时间维），仅做空间双线性插值。

### 5.5 边界处理

- 查询点超出网格范围时 `contains()` 返回 false，该数据源跳过
- 连续索引 clamp 到有效范围，避免越界

---

## 6. 统计量计算

### 6.1 扩散面积

使用活跃粒子位置的标准差估算 2σ 椭圆面积：

```javascript
σ_lat = stddev(粒子纬度)
σ_lng = stddev(粒子经度)
Area = π * (2σ_lat × 111.32 km) * (2σ_lng × 111.32 × cos(lat) km)
```

### 6.2 最远漂移距离

所有活跃粒子到溢油源的 Haversine 球面距离最大值：

```javascript
d = 2 * R * atan2(sqrt(a), sqrt(1-a))
a = sin²(Δlat/2) + cos(lat1) * cos(lat2) * sin²(Δlng/2)
```

### 6.3 质心

活跃粒子位置的算术平均：

```javascript
centerLat = mean(active.lat)
centerLng = mean(active.lng)
```

### 6.4 风化统计

取第一个活跃粒子的蒸发/分散/乳化比例作为代表值（简化处理，因所有粒子风化参数相同）。

---

## 7. 油品物性数据库

| 油品 | 密度 (kg/m³) | 粘度 (mPa·s) | API度 | 蒸发系数 | 挥发组分 | 分散性 |
|------|-------------|-------------|-------|---------|---------|-------|
| 原油 | 860 | 12 | 33 | 0.042 | 25% | 0.5 |
| 燃料油 | 950 | 180 | 17 | 0.015 | 8% | 0.2 |
| 柴油 | 840 | 4 | 37 | 0.065 | 45% | 0.7 |
| 汽油 | 740 | 0.6 | 60 | 0.12 | 80% | 0.9 |

---

## 8. 仿真执行流程

```
用户点击 "开始模拟"
       │
       ▼
  [异步加载网格数据]  ← fetch /api/grid/{wind,current,temperature,landmask}
       │                 创建 FieldGrid 对象
       ▼
  initialize()        ← 创建 N 个粒子 (瞬时释放 / 预分配)
       │
       ▼
  start() → _tick()   ← requestAnimationFrame 循环
       │
       ├─→ _step()    ← 每帧推进 playbackSpeed 个时间步
       │     │
       │     ├─ 持续溢油: 按比例释放新粒子
       │     ├─ 风化计算: 蒸发、分散、乳化
       │     └─ 逐粒子循环:
       │          ├─ 插值风场 (FieldGrid.sample u10/v10)
       │          ├─ 插值海流 (FieldGrid.sample uo/vo)
       │          ├─ 计算风漂流 + 海流 + 湍流扩散
       │          ├─ 更新位置 (经纬度增量)
       │          └─ 陆海掩膜检查 → 搁浅判定
       │
       ├─→ _updateStats()  ← 面积、漂移、风化统计
       │
       └─→ onUpdate(particles, stats, time) → Canvas 渲染 + UI 更新
```

### 8.1 帧率控制

- 目标帧间隔: 50ms（约 20 FPS）
- 每帧物理推进量: `playbackSpeed × timeStep` 秒
- 1x 速度 = 每帧推进 10 分钟模拟时间
- 10x 速度 = 每帧推进 100 分钟模拟时间

---

## 9. 前端渲染

### 9.1 Canvas 粒子叠加层

使用 Leaflet 自定义 `L.Layer` 扩展，在地图 overlay pane 上绑定 Canvas：

- 每帧清除并重绘所有粒子
- 经纬度 → 像素坐标: `map.latLngToContainerPoint()`
- 视口外粒子跳过（±20px 容差）
- 粒子大小随 zoom 级别缩放: `radius * max(0.6, (zoom-4)/4)`

### 9.2 粒子颜色映射

| 油膜厚度 | 颜色 | RGBA |
|---------|------|------|
| > 1.0 mm | 深褐色 | rgba(20, 15, 10, 0.9) |
| 0.1–1.0 mm | 褐色 | rgba(70, 40, 15, 0.85) |
| 0.01–0.1 mm | 棕色 | rgba(130, 80, 30, 0.7) |
| < 0.01 mm | 金黄色 | rgba(180, 130, 40, 0.5) |
| 搁浅 | 灰色 | rgba(128, 128, 128, 0.7) |

每个粒子绘制两层：外层光晕（2 倍半径，低透明度）+ 核心圆点。

### 9.3 缓存与重绘

`_lastParticles` 缓存最近一帧粒子数据，地图 pan/zoom 事件触发 `_reset()` 时使用缓存重新渲染，避免模拟完成后拖动地图粒子消失。

---

## 10. 结果核查指南

### 10.1 物理合理性检查

| 检查项 | 合理范围 | 核查方法 |
|--------|---------|---------|
| 48h 漂移距离 | 10–60 km | 风速 5 m/s × 3% × 48h ≈ 26 km (仅风漂流) |
| 蒸发量（原油） | 20–30% | Stiver-Mackay: K√t ≈ 0.042×√48 ≈ 29% (接近 25% 上限) |
| 扩散面积 | 5–50 km² | 取决于风速和模拟时长 |
| 搁浅 | 距岸 < 20km 时可能 | 检查溢油源到海岸线距离 |
| 粘度增长 | 50–100 倍 | exp(5×0.25) × (1/(1-0.7))^2.5 ≈ 65 倍 |

### 10.2 网格数据验证

可使用 Python 独立验证插值结果：

```python
import json, numpy as np

with open('data/processed/wind_grid.json') as f:
    d = json.load(f)

lat, lon = np.array(d['lat']), np.array(d['lon'])
u10 = np.array(d['u10']).reshape(d['shape'])
v10 = np.array(d['v10']).reshape(d['shape'])

# 查看 t=0 时刻 (38.5°N, 119.0°E) 附近的风场
lat_idx = np.argmin(np.abs(lat - 38.5))
lon_idx = np.argmin(np.abs(lon - 119.0))
print(f"u10={u10[0, lat_idx, lon_idx]:.3f} m/s")
print(f"v10={v10[0, lat_idx, lon_idx]:.3f} m/s")
print(f"wind_speed={np.sqrt(u10[0,lat_idx,lon_idx]**2 + v10[0,lat_idx,lon_idx]**2):.3f} m/s")
```

### 10.3 与原始 NetCDF 对比

```python
import xarray as xr

ds = xr.open_dataset('data/raw/era5_wind.nc')
print(ds.sel(latitude=38.5, longitude=119.0, method='nearest').isel(time=0))
```

### 10.4 参数敏感性分析建议

| 参数 | 推荐测试范围 | 影响机制 |
|------|------------|---------|
| 时间步长 | 5/10/30/60 min | 步长过大可能跳过陆地掩膜 |
| 粒子数量 | 500–5000 | 影响统计稳定性和扩散面积精度 |
| 风漂系数 | 2%–4% | 直接影响漂移速度 |
| 扩散系数 | 0.5–5.0 m²/s | 影响扩散面积 |

---

## 11. 已知局限与改进方向

### 11.1 当前局限

1. **风化模型为全局统一**: 所有粒子使用相同的蒸发/分散比例，未按粒子个体年龄差异化
2. **海温未参与风化计算**: `tempGrid` 已加载但蒸发模型中仍使用滑块水温值
3. **陆海掩膜分辨率**: ERA5-Land 0.1° ≈ 11km，海岸线精度有限
4. **无潮汐模拟**: 未引入潮流场，渤海潮汐影响较大
5. **搁浅模型简化**: 仅做二值判定（搁浅/不搁浅），无冲刷再浮机制
6. **无波浪场**: 分散和乳化模型中波浪能由风速参数化，未使用真实波高数据

### 11.2 可能的改进

- 引入 CMEMS 潮流数据或调和常数驱动潮汐
- 使用更高分辨率的海岸线数据（如 GSHHG）
- 逐粒子个体化风化（基于各自年龄）
- 接入真实海温用于蒸发计算
- 添加油膜可视化热力图（Kernel Density Estimation）
