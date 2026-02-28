const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API: 模拟海洋环境数据（风场、流场）
app.get('/api/environment', (req, res) => {
  const { lat, lng, time } = req.query;
  // 简化的环境场数据生成（实际应用中应接入气象/海洋数据源）
  const t = parseFloat(time) || 0;
  const windSpeed = 5 + 3 * Math.sin(t * 0.001); // m/s
  const windDir = (180 + 30 * Math.sin(t * 0.0005)) % 360; // 度
  const currentSpeed = 0.3 + 0.15 * Math.sin(t * 0.0008); // m/s
  const currentDir = (90 + 20 * Math.cos(t * 0.0003)) % 360; // 度

  res.json({
    wind: { speed: windSpeed, direction: windDir },
    current: { speed: currentSpeed, direction: currentDir },
    temperature: 18 + 5 * Math.sin(t * 0.0001),
    waveHeight: 0.5 + 0.3 * Math.sin(t * 0.0006)
  });
});

// API: 获取预定义溢油场景
app.get('/api/scenarios', (req, res) => {
  res.json([
    {
      id: 1,
      name: '渤海湾溢油事故',
      lat: 38.5,
      lng: 119.0,
      oilVolume: 500,
      oilType: 'crude',
      description: '渤海湾原油泄漏模拟场景'
    },
    {
      id: 2,
      name: '南海平台泄漏',
      lat: 19.5,
      lng: 112.0,
      oilVolume: 1000,
      oilType: 'crude',
      description: '南海钻井平台溢油模拟场景'
    },
    {
      id: 3,
      name: '东海油轮事故',
      lat: 30.0,
      lng: 124.0,
      oilVolume: 2000,
      oilType: 'fuel',
      description: '东海油轮碰撞溢油模拟场景'
    }
  ]);
});

app.listen(PORT, () => {
  console.log(`海上溢油预测仿真系统已启动: http://localhost:${PORT}`);
});
