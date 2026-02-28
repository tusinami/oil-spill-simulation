#!/usr/bin/env python3
"""海上溢油预测仿真系统 - HTTP 服务器"""

import gzip
import http.server
import json
import math
import os
from pathlib import Path

PORT = 3000
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
DATA_DIR = Path(__file__).parent / 'data' / 'processed'

# ==================== 网格数据缓存 ====================
_grid_cache = {}


def _load_grid(name):
    """加载预处理的 JSON 网格文件（缓存到内存）"""
    if name not in _grid_cache:
        filepath = DATA_DIR / f'{name}_grid.json'
        if filepath.exists():
            with open(filepath, 'r') as f:
                _grid_cache[name] = f.read()
            size_kb = filepath.stat().st_size / 1024
            print(f'  已加载网格数据: {name} ({size_kb:.0f} KB)')
        else:
            _grid_cache[name] = None
    return _grid_cache[name]


# 启动时预加载所有可用网格数据
def _preload_grids():
    print('检查网格数据...')
    available = []
    for name in ('wind', 'current', 'temperature', 'landmask'):
        data = _load_grid(name)
        if data:
            available.append(name)
    if available:
        total_kb = sum(len(_grid_cache[n]) for n in available if _grid_cache[n]) / 1024
        print(f'  已加载: {", ".join(available)} (总计 {total_kb:.0f} KB)')
    else:
        print('  无网格数据，运行 data/preprocess.py 准备数据')


class SimulationHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/scenarios'):
            self._handle_scenarios()
        elif self.path.startswith('/api/environment'):
            self._handle_environment()
        elif self.path == '/api/grid-status':
            self._handle_grid_status()
        elif self.path.startswith('/api/grid/'):
            self._handle_grid()
        else:
            super().do_GET()

    def _handle_scenarios(self):
        scenarios = [
            {"id": 1, "name": "渤海湾溢油事故", "lat": 38.5, "lng": 119.0,
             "oilVolume": 500, "oilType": "crude", "description": "渤海湾原油泄漏模拟场景"},
            {"id": 2, "name": "南海平台泄漏", "lat": 19.5, "lng": 112.0,
             "oilVolume": 1000, "oilType": "crude", "description": "南海钻井平台溢油模拟场景"},
            {"id": 3, "name": "东海油轮事故", "lat": 30.0, "lng": 124.0,
             "oilVolume": 2000, "oilType": "fuel", "description": "东海油轮碰撞溢油模拟场景"},
            {"id": 4, "name": "管道持续泄漏", "lat": 37.8, "lng": 120.5,
             "oilVolume": 800, "oilType": "crude", "spillMode": "continuous",
             "spillDuration": 12, "description": "海底管道持续泄漏模拟场景（持续12小时）"},
        ]
        self._json_response(scenarios)

    def _handle_environment(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        t = float(params.get('time', [0])[0])
        data = {
            "wind": {"speed": 5 + 3 * math.sin(t * 0.001), "direction": (180 + 30 * math.sin(t * 0.0005)) % 360},
            "current": {"speed": 0.3 + 0.15 * math.sin(t * 0.0008), "direction": (90 + 20 * math.cos(t * 0.0003)) % 360},
            "temperature": 18 + 5 * math.sin(t * 0.0001),
            "waveHeight": 0.5 + 0.3 * math.sin(t * 0.0006),
        }
        self._json_response(data)

    def _handle_grid_status(self):
        """返回各网格数据的可用状态"""
        status = {}
        for name in ('wind', 'current', 'temperature', 'landmask'):
            filepath = DATA_DIR / f'{name}_grid.json'
            status[name] = filepath.exists()
        self._json_response(status)

    def _handle_grid(self):
        """提供网格数据（支持 gzip 压缩）"""
        name = self.path.split('/api/grid/')[-1].split('?')[0]

        if name not in ('wind', 'current', 'temperature', 'landmask'):
            self.send_error(404, f'Unknown grid: {name}')
            return

        data = _load_grid(name)
        if data is None:
            self.send_error(404, f'Grid data not available: {name}')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'public, max-age=3600')

        accept_encoding = self.headers.get('Accept-Encoding', '')
        if 'gzip' in accept_encoding:
            compressed = gzip.compress(data.encode('utf-8'))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', len(compressed))
            self.end_headers()
            self.wfile.write(compressed)
        else:
            encoded = data.encode('utf-8')
            self.send_header('Content-Length', len(encoded))
            self.end_headers()
            self.wfile.write(encoded)

    def _json_response(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))


if __name__ == '__main__':
    _preload_grids()
    with http.server.HTTPServer(('', PORT), SimulationHandler) as httpd:
        print(f'海上溢油预测仿真系统已启动: http://localhost:{PORT}')
        httpd.serve_forever()
