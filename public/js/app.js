/**
 * 海上溢油预测仿真系统 - 前端控制器
 * 负责地图渲染、UI交互、Canvas粒子绘制、网格数据加载
 */

(function () {
  'use strict';

  // ======================== 地图初始化 ========================
  const map = L.map('map', {
    center: [38.5, 119.0],
    zoom: 8,
    minZoom: 3,
    maxZoom: 15
  });

  // 添加底图（OpenStreetMap）
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  // Canvas 叠加层用于绘制粒子
  const canvasLayer = L.canvas({ padding: 0.5 });

  // 溢油源标记
  let spillMarker = null;
  // 轨迹线
  let trajectoryLine = null;
  // 粒子圆形图层
  let particleCircles = [];

  // ======================== 仿真引擎 ========================
  const sim = new OilSpillSimulation();

  // ======================== DOM 元素引用 ========================
  const els = {
    scenarioSelect: document.getElementById('scenarioSelect'),
    spillLat: document.getElementById('spillLat'),
    spillLng: document.getElementById('spillLng'),
    oilVolume: document.getElementById('oilVolume'),
    oilType: document.getElementById('oilType'),
    spillMode: document.getElementById('spillMode'),
    spillDuration: document.getElementById('spillDuration'),
    spillDurationGroup: document.getElementById('spillDurationGroup'),
    windSpeed: document.getElementById('windSpeed'),
    windSpeedVal: document.getElementById('windSpeedVal'),
    windDir: document.getElementById('windDir'),
    windDirVal: document.getElementById('windDirVal'),
    currentSpeed: document.getElementById('currentSpeed'),
    currentSpeedVal: document.getElementById('currentSpeedVal'),
    currentDir: document.getElementById('currentDir'),
    currentDirVal: document.getElementById('currentDirVal'),
    waterTemp: document.getElementById('waterTemp'),
    waterTempVal: document.getElementById('waterTempVal'),
    simDuration: document.getElementById('simDuration'),
    timeStep: document.getElementById('timeStep'),
    particleCount: document.getElementById('particleCount'),
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnReset: document.getElementById('btnReset'),
    simStatus: document.getElementById('simStatus'),
    simTime: document.getElementById('simTime'),
    progressFill: document.getElementById('progressFill'),
    progressTime: document.getElementById('progressTime'),
    progressPercent: document.getElementById('progressPercent'),
    windArrow: document.getElementById('windArrow'),
    windInfo: document.getElementById('windInfo'),
    // 统计面板
    statArea: document.getElementById('statArea'),
    statRemaining: document.getElementById('statRemaining'),
    statEvaporated: document.getElementById('statEvaporated'),
    statDispersed: document.getElementById('statDispersed'),
    statBeached: document.getElementById('statBeached'),
    statCenterLat: document.getElementById('statCenterLat'),
    statCenterLng: document.getElementById('statCenterLng'),
    statMaxDrift: document.getElementById('statMaxDrift'),
    statCoastDist: document.getElementById('statCoastDist'),
    // 油品属性
    propDensity: document.getElementById('propDensity'),
    propViscosity: document.getElementById('propViscosity'),
    propAPI: document.getElementById('propAPI'),
    propEvap: document.getElementById('propEvap'),
    propEmulsion: document.getElementById('propEmulsion'),
    // 网格数据
    gridStatus: document.getElementById('gridStatus'),
    useGridData: document.getElementById('useGridData'),
  };

  // ======================== 初始化场景 ========================
  const scenarios = [
    { id: 1, name: '渤海湾溢油事故', lat: 38.5, lng: 119.0, oilVolume: 500, oilType: 'crude', spillMode: 'instant' },
    { id: 2, name: '南海平台泄漏', lat: 19.5, lng: 112.0, oilVolume: 1000, oilType: 'crude', spillMode: 'instant' },
    { id: 3, name: '东海油轮事故', lat: 30.0, lng: 124.0, oilVolume: 2000, oilType: 'fuel', spillMode: 'instant' },
    { id: 4, name: '管道持续泄漏', lat: 37.8, lng: 120.5, oilVolume: 800, oilType: 'crude', spillMode: 'continuous', spillDuration: 12 }
  ];

  scenarios.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    els.scenarioSelect.appendChild(opt);
  });

  // ======================== 网格数据加载 ========================
  let gridDataLoaded = false;
  let gridLoadingPromise = null;

  /**
   * 异步加载网格数据（并行请求所有可用网格）
   */
  async function loadGridData() {
    if (gridDataLoaded) return true;
    if (gridLoadingPromise) return gridLoadingPromise;

    gridLoadingPromise = _doLoadGridData();
    return gridLoadingPromise;
  }

  async function _doLoadGridData() {
    try {
      // 先查询可用状态
      const statusRes = await fetch('/api/grid-status');
      const status = await statusRes.json();

      const loadTasks = [];
      const names = [];

      for (const [name, available] of Object.entries(status)) {
        if (available) {
          loadTasks.push(fetch(`/api/grid/${name}`).then(r => r.json()));
          names.push(name);
        }
      }

      if (loadTasks.length === 0) {
        updateGridStatus('none');
        return false;
      }

      updateGridStatus('loading');
      const results = await Promise.all(loadTasks);

      for (let i = 0; i < names.length; i++) {
        const grid = new FieldGrid(results[i]);
        switch (names[i]) {
          case 'wind':
            sim.windGrid = grid;
            break;
          case 'current':
            sim.currentGrid = grid;
            break;
          case 'temperature':
            sim.tempGrid = grid;
            break;
          case 'landmask':
            sim.landMask = grid;
            break;
        }
      }

      gridDataLoaded = true;
      updateGridStatus('loaded', names);
      console.log('[Grid] 网格数据已加载:', names.join(', '));
      return true;
    } catch (err) {
      console.error('[Grid] 加载失败:', err);
      updateGridStatus('error');
      return false;
    }
  }

  function updateGridStatus(state, names) {
    if (!els.gridStatus) return;
    switch (state) {
      case 'loading':
        els.gridStatus.textContent = '加载数据中...';
        els.gridStatus.className = 'grid-status loading';
        break;
      case 'loaded':
        els.gridStatus.textContent = '网格数据已加载 (' + names.join(', ') + ')';
        els.gridStatus.className = 'grid-status loaded';
        break;
      case 'error':
        els.gridStatus.textContent = '数据加载失败';
        els.gridStatus.className = 'grid-status error';
        break;
      case 'none':
        els.gridStatus.textContent = '无网格数据';
        els.gridStatus.className = 'grid-status none';
        break;
    }
  }

  // ======================== Canvas 粒子渲染器 ========================
  const ParticleOverlay = L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'particle-canvas');
      const pane = map.getPane('overlayPane');
      pane.appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');
      this._lastParticles = null;
      map.on('moveend zoomend resize', this._reset, this);
      this._reset();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off('moveend zoomend resize', this._reset, this);
    },
    _reset() {
      const size = this._map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      if (this._lastParticles) {
        this.render(this._lastParticles);
      }
    },
    render(particles) {
      if (!this._ctx || !this._map) return;
      this._lastParticles = particles;
      const ctx = this._ctx;
      const size = this._map.getSize();
      ctx.clearRect(0, 0, size.x, size.y);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        // 搁浅粒子也要渲染（灰色）
        if (!p.active && !p.beached) continue;

        const point = this._map.latLngToContainerPoint([p.lat, p.lng]);
        const x = point.x;
        const y = point.y;

        if (x < -20 || x > size.x + 20 || y < -20 || y > size.y + 20) continue;

        let color, glowColor, radius;

        if (p.beached) {
          // 搁浅粒子：灰色
          color = 'rgba(128, 128, 128, 0.7)';
          glowColor = 'rgba(128, 128, 128, 0.2)';
          radius = 4;
        } else if (p.thickness > 0.001) {
          color = 'rgba(20, 15, 10, 0.9)';
          glowColor = 'rgba(20, 15, 10, 0.3)';
          radius = 5;
        } else if (p.thickness > 0.0001) {
          color = 'rgba(70, 40, 15, 0.85)';
          glowColor = 'rgba(70, 40, 15, 0.2)';
          radius = 4.5;
        } else if (p.thickness > 0.00001) {
          color = 'rgba(130, 80, 30, 0.7)';
          glowColor = 'rgba(130, 80, 30, 0.15)';
          radius = 4;
        } else {
          color = 'rgba(180, 130, 40, 0.5)';
          glowColor = 'rgba(180, 130, 40, 0.1)';
          radius = 3;
        }

        const zoom = this._map.getZoom();
        const zoomScale = Math.max(0.6, (zoom - 4) / 4);
        radius = radius * zoomScale;

        // 外层光晕
        ctx.beginPath();
        ctx.arc(x, y, radius * 2, 0, 2 * Math.PI);
        ctx.fillStyle = glowColor;
        ctx.fill();

        // 核心粒子
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  });

  const particleOverlay = new ParticleOverlay();
  particleOverlay.addTo(map);

  // ======================== 事件处理 ========================

  // 滑块实时更新显示值
  els.windSpeed.addEventListener('input', () => {
    els.windSpeedVal.textContent = parseFloat(els.windSpeed.value).toFixed(1);
    sim.windSpeed = parseFloat(els.windSpeed.value);
    updateWindIndicator();
  });
  els.windDir.addEventListener('input', () => {
    els.windDirVal.textContent = els.windDir.value;
    sim.windDir = parseFloat(els.windDir.value);
    updateWindIndicator();
  });
  els.currentSpeed.addEventListener('input', () => {
    els.currentSpeedVal.textContent = parseFloat(els.currentSpeed.value).toFixed(2);
    sim.currentSpeed = parseFloat(els.currentSpeed.value);
  });
  els.currentDir.addEventListener('input', () => {
    els.currentDirVal.textContent = els.currentDir.value;
    sim.currentDir = parseFloat(els.currentDir.value);
  });
  els.waterTemp.addEventListener('input', () => {
    els.waterTempVal.textContent = els.waterTemp.value;
    sim.waterTemp = parseFloat(els.waterTemp.value);
  });

  // 油品类型变化
  els.oilType.addEventListener('change', () => {
    updateOilProperties();
  });

  // 溢油模式切换
  els.spillMode.addEventListener('change', () => {
    const isContinuous = els.spillMode.value === 'continuous';
    els.spillDurationGroup.style.display = isContinuous ? 'block' : 'none';
  });

  // 使用网格数据复选框
  if (els.useGridData) {
    els.useGridData.addEventListener('change', () => {
      sim.useGridData = els.useGridData.checked;
    });
  }

  // 场景选择
  els.scenarioSelect.addEventListener('change', () => {
    const val = els.scenarioSelect.value;
    if (val === 'custom') return;
    const scenario = scenarios.find(s => s.id === parseInt(val));
    if (scenario) {
      els.spillLat.value = scenario.lat;
      els.spillLng.value = scenario.lng;
      els.oilVolume.value = scenario.oilVolume;
      els.oilType.value = scenario.oilType;
      els.spillMode.value = scenario.spillMode || 'instant';
      const isContinuous = scenario.spillMode === 'continuous';
      els.spillDurationGroup.style.display = isContinuous ? 'block' : 'none';
      if (isContinuous && scenario.spillDuration) {
        els.spillDuration.value = scenario.spillDuration;
      }
      map.setView([scenario.lat, scenario.lng], 8);
      updateOilProperties();
      updateSpillMarker();
    }
  });

  // 地图点击设置溢油位置
  map.on('click', (e) => {
    if (sim.isRunning) return;
    els.spillLat.value = e.latlng.lat.toFixed(4);
    els.spillLng.value = e.latlng.lng.toFixed(4);
    els.scenarioSelect.value = 'custom';
    updateSpillMarker();
  });

  // 开始模拟
  els.btnStart.addEventListener('click', async () => {
    if (sim.isRunning && !sim.isPaused) return;

    if (!sim.isRunning) {
      // 读取参数
      sim.spillLat = parseFloat(els.spillLat.value);
      sim.spillLng = parseFloat(els.spillLng.value);
      sim.oilVolume = parseFloat(els.oilVolume.value);
      sim.oilType = els.oilType.value;
      sim.spillMode = els.spillMode.value;
      sim.spillDuration = parseFloat(els.spillDuration.value);
      sim.particleCount = parseInt(els.particleCount.value);
      sim.windSpeed = parseFloat(els.windSpeed.value);
      sim.windDir = parseFloat(els.windDir.value);
      sim.currentSpeed = parseFloat(els.currentSpeed.value);
      sim.currentDir = parseFloat(els.currentDir.value);
      sim.waterTemp = parseFloat(els.waterTemp.value);
      sim.timeStep = parseInt(els.timeStep.value) * 60;
      sim.maxTime = parseInt(els.simDuration.value) * 3600;

      // 加载网格数据（首次）
      if (els.useGridData && els.useGridData.checked && !gridDataLoaded) {
        els.btnStart.disabled = true;
        els.simStatus.textContent = '加载数据...';
        els.simStatus.className = 'status-badge loading';
        await loadGridData();
      }

      sim.useGridData = els.useGridData ? els.useGridData.checked : false;
      sim.initialize();
      updateSpillMarker();
    }

    sim.start();
    els.simStatus.textContent = '模拟中';
    els.simStatus.className = 'status-badge running';
    els.btnStart.disabled = true;
    els.btnPause.disabled = false;
    setControlsDisabled(true);
  });

  // 暂停
  els.btnPause.addEventListener('click', () => {
    sim.pause();
    if (sim.isPaused) {
      els.simStatus.textContent = '已暂停';
      els.simStatus.className = 'status-badge paused';
      els.btnStart.disabled = false;
      els.btnPause.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 继续';
    } else {
      els.simStatus.textContent = '模拟中';
      els.simStatus.className = 'status-badge running';
      els.btnStart.disabled = true;
      els.btnPause.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 暂停';
    }
  });

  // 重置
  els.btnReset.addEventListener('click', () => {
    sim.reset();
    clearMapLayers();
    els.simStatus.textContent = '就绪';
    els.simStatus.className = 'status-badge';
    els.simTime.textContent = 'T + 0h 0m';
    els.btnStart.disabled = false;
    els.btnPause.disabled = true;
    els.btnPause.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 暂停';
    setControlsDisabled(false);
    resetStats();
    particleOverlay.render([]);
  });

  // 播放速度
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sim.playbackSpeed = parseInt(btn.dataset.speed);
    });
  });

  // ======================== 仿真回调 ========================
  sim.onUpdate = (particles, stats, time) => {
    // 渲染粒子
    particleOverlay.render(particles);

    // 更新轨迹线
    if (sim.trajectory.length > 1) {
      const latLngs = sim.trajectory.map(t => [t.lat, t.lng]);
      if (trajectoryLine) {
        trajectoryLine.setLatLngs(latLngs);
      } else {
        trajectoryLine = L.polyline(latLngs, {
          color: '#ff4444',
          weight: 2,
          dashArray: '5,5',
          opacity: 0.8
        }).addTo(map);
      }
    }

    // 更新时间显示
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    els.simTime.textContent = `T + ${hours}h ${minutes}m`;

    // 更新进度条
    const progress = (time / sim.maxTime) * 100;
    els.progressFill.style.width = progress + '%';
    els.progressTime.textContent = `${hours}h / ${Math.floor(sim.maxTime / 3600)}h`;
    els.progressPercent.textContent = progress.toFixed(1) + '%';

    // 更新统计面板
    els.statArea.textContent = stats.area.toFixed(2);
    els.statRemaining.textContent = stats.remaining.toFixed(1);
    els.statEvaporated.textContent = stats.evaporated.toFixed(1);
    els.statDispersed.textContent = stats.dispersed.toFixed(1);
    els.statCenterLat.textContent = stats.centerLat.toFixed(4);
    els.statCenterLng.textContent = stats.centerLng.toFixed(4);
    els.statMaxDrift.textContent = stats.maxDrift.toFixed(2);

    // 搁浅统计
    if (els.statBeached) {
      els.statBeached.textContent = stats.beached || 0;
    }

    // 更新油品实时物性
    els.propEmulsion.textContent = (stats.emulsionWater || 0).toFixed(1) + '%';
    if (stats.viscosity) {
      els.propViscosity.textContent = stats.viscosity.toFixed(1) + ' mPa·s';
    }
  };

  sim.onComplete = () => {
    els.simStatus.textContent = '已完成';
    els.simStatus.className = 'status-badge completed';
    els.btnStart.disabled = true;
    els.btnPause.disabled = true;
  };

  // ======================== 辅助函数 ========================

  function updateSpillMarker() {
    const lat = parseFloat(els.spillLat.value);
    const lng = parseFloat(els.spillLng.value);
    if (spillMarker) {
      spillMarker.setLatLng([lat, lng]);
    } else {
      const spillIcon = L.divIcon({
        className: 'spill-marker',
        html: `<div class="spill-icon">
                 <svg width="24" height="24" viewBox="0 0 24 24" fill="#e74c3c" stroke="white" stroke-width="1">
                   <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/>
                 </svg>
               </div>`,
        iconSize: [24, 32],
        iconAnchor: [12, 32]
      });
      spillMarker = L.marker([lat, lng], { icon: spillIcon }).addTo(map);
      spillMarker.bindPopup(`溢油源<br>位置: ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`);
    }
  }

  function updateOilProperties() {
    const props = OIL_PROPERTIES[els.oilType.value];
    if (!props) return;
    els.propDensity.textContent = props.density + ' kg/m³';
    els.propViscosity.textContent = props.viscosity + ' mPa·s';
    els.propAPI.textContent = props.api;
    els.propEvap.textContent = props.evapRate.toFixed(3);
    els.propEmulsion.textContent = '0%';
  }

  function updateWindIndicator() {
    const speed = parseFloat(els.windSpeed.value);
    const dir = parseFloat(els.windDir.value);
    els.windArrow.style.transform = `rotate(${dir}deg)`;
    els.windInfo.textContent = `风速: ${speed.toFixed(1)} m/s`;
  }

  function clearMapLayers() {
    if (trajectoryLine) {
      map.removeLayer(trajectoryLine);
      trajectoryLine = null;
    }
  }

  function setControlsDisabled(disabled) {
    const inputs = document.querySelectorAll('.control-panel input, .control-panel select');
    inputs.forEach(input => {
      if (input.type === 'range') {
        if (['windSpeed', 'windDir', 'currentSpeed', 'currentDir', 'waterTemp'].includes(input.id)) {
          return;
        }
      }
      // 网格数据复选框在模拟中也保持可用
      if (input.id === 'useGridData') return;
      input.disabled = disabled;
    });
  }

  function resetStats() {
    els.statArea.textContent = '0.00';
    els.statRemaining.textContent = '100.0';
    els.statEvaporated.textContent = '0.0';
    els.statDispersed.textContent = '0.0';
    if (els.statBeached) els.statBeached.textContent = '0';
    els.statCenterLat.textContent = '-';
    els.statCenterLng.textContent = '-';
    els.statMaxDrift.textContent = '0.00';
    els.statCoastDist.textContent = '-';
    els.progressFill.style.width = '0%';
    els.progressTime.textContent = `0h / ${els.simDuration.value}h`;
    els.progressPercent.textContent = '0%';
  }

  // ======================== 初始化 ========================
  updateOilProperties();
  updateWindIndicator();
  updateSpillMarker();

  // 默认选中渤海湾场景
  els.scenarioSelect.value = '1';

  // 页面加载时自动检测并加载网格数据
  loadGridData();
})();
