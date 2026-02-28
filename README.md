# 海上溢油预测仿真系统

> Oil Spill Prediction Simulation System

基于 Lagrangian 粒子追踪法的海上溢油预测仿真 Demo，集成真实海洋气象网格数据，B/S 架构前端可视化。

- **版本**: v1.0.0
- **创建时间**: 2026-02-28
- **作者**: wangxiong

## 功能特性

- Lagrangian 粒子追踪溢油漂移模拟
- 瞬时溢油 / 持续溢油两种模式
- ERA5 真实风场数据驱动（逐小时，0.25° 分辨率）
- CMEMS 真实海流与海温数据驱动（6 小时，0.083° 分辨率）
- ERA5-Land 陆海掩膜实现岸线搁浅判定
- Leaflet.js 交互式地图 + Canvas 高性能粒子渲染
- 实时统计：扩散面积、漂移距离、蒸发/分散/乳化/搁浅

## 物理模型

| 过程 | 模型 | 说明 |
|------|------|------|
| 风漂流 | 3% 风速 + 15° Ekman 偏转 | 经典经验公式 |
| 海流输运 | CMEMS 表层流场直接驱动 | uo/vo 分量 |
| 湍流扩散 | Box-Muller 高斯随机游走 | D = 1.0 + 0.5W m²/s |
| 蒸发 | Stiver-Mackay 简化模型 | 温度/风速修正 |
| 自然分散 | Delvigne-Sweeney 简化模型 | 风速 > 5 m/s 触发 |
| 乳化 | Mackay 简化模型 | 最大含水率 70% |
| 油膜扩展 | Fay 三阶段幂律模型 | 厚度 ~ t^(-1/3) |
| 搁浅 | 陆海掩膜二值判定 | lsm > 0.5 为陆地 |

## 真实数据源

| 数据 | 来源 | 产品 |
|------|------|------|
| 10m 风场 | ECMWF ERA5 | reanalysis-era5-single-levels |
| 表层海流 | Copernicus CMEMS | GLOBAL_ANALYSISFORECAST_PHY_001_024 |
| 海表温度 | Copernicus CMEMS | GLOBAL_ANALYSISFORECAST_PHY_001_024 |
| 陆海掩膜 | ECMWF ERA5-Land | reanalysis-era5-land |

数据覆盖范围：36–40°N, 118–124°E（渤海/黄海），2024-01-15 ~ 2024-01-17

## 快速开始

### 环境要求

- Python 3.8+
- 现代浏览器（Chrome / Firefox / Safari）

### 安装与运行

```bash
# 1. 安装 Python 依赖（仅数据下载/预处理需要）
pip install -r data/requirements.txt

# 2. 下载真实数据（需 CMEMS + CDS 账号）
python data/download_cmems.py
python data/download_era5_wind.py
python data/download_landmask.py

# 3. 预处理 NetCDF → JSON
python data/preprocess.py

# 4. 启动服务器
python server.py
```

浏览器访问 http://localhost:3000

> 如果跳过步骤 1-3，系统会自动降级为均匀标量场模式（使用滑块手动设置风速/流速）。

## 项目结构

```
├── server.py                   # HTTP 服务器 (Python)
├── public/
│   ├── index.html              # 主页面
│   ├── css/style.css           # 暗色主题样式
│   └── js/
│       ├── simulation.js       # 核心仿真引擎
│       └── app.js              # 前端控制器
├── data/
│   ├── download_*.py           # 数据下载脚本
│   ├── preprocess.py           # NetCDF → JSON
│   ├── raw/                    # 原始 NetCDF
│   └── processed/              # JSON 网格数据
└── docs/
    └── technical-document.md   # 技术文档
```

## 技术文档

详细算法说明、公式推导和结果核查指南请参考 [docs/technical-document.md](docs/technical-document.md)。

## 许可证

MIT License
