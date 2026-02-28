#!/usr/bin/env python3
"""
下载 ERA5 Single Levels 10m 风场数据
变量: u10 (10m东向风速), v10 (10m北向风速)
区域: 渤海/黄海 (36-40°N, 118-124°E)
时段: 2024-01-15 ~ 2024-01-17 (48h, 逐小时)

前置条件:
  1. 注册 CDS 账号: https://cds.climate.copernicus.eu/
  2. 配置 ~/.cdsapirc:
     url: https://cds.climate.copernicus.eu/api
     key: <your-uid>:<your-api-key>
"""

import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "raw"
OUTPUT_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "era5_wind.nc"

# 检查 .cdsapirc
CDSAPIRC = Path.home() / ".cdsapirc"


def main():
    if not CDSAPIRC.exists():
        print("错误: 未找到 ~/.cdsapirc 配置文件")
        print()
        print("请按以下步骤配置:")
        print("1. 登录 https://cds.climate.copernicus.eu/")
        print("2. 进入 User Profile 页面获取 API Key")
        print("3. 创建 ~/.cdsapirc 文件，内容:")
        print("   url: https://cds.climate.copernicus.eu/api")
        print("   key: <your-uid>:<your-api-key>")
        sys.exit(1)

    try:
        import cdsapi
    except ImportError:
        print("错误: 请先安装 cdsapi 包")
        print("  pip install cdsapi")
        sys.exit(1)

    print("正在从 ERA5 下载 10m 风场数据...")
    print(f"  区域: 36-40°N, 118-124°E")
    print(f"  时段: 2024-01-15 ~ 2024-01-17 (逐小时)")
    print(f"  变量: u10, v10")
    print(f"  输出: {OUTPUT_FILE}")
    print()
    print("注意: CDS 请求可能需要排队等待，请耐心...")
    print()

    client = cdsapi.Client()

    client.retrieve(
        "reanalysis-era5-single-levels",
        {
            "product_type": ["reanalysis"],
            "variable": [
                "10m_u_component_of_wind",
                "10m_v_component_of_wind",
            ],
            "year": ["2024"],
            "month": ["01"],
            "day": ["15", "16", "17"],
            "time": [f"{h:02d}:00" for h in range(24)],
            "area": [40, 118, 36, 124],  # N, W, S, E
            "data_format": "netcdf",
        },
        str(OUTPUT_FILE),
    )

    print(f"ERA5 风场数据下载完成: {OUTPUT_FILE}")
    print(f"文件大小: {OUTPUT_FILE.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
