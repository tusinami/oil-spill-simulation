#!/usr/bin/env python3
"""
下载 ERA5-Land 陆海掩膜 (Land-Sea Mask)
变量: lsm (0=海洋, 1=陆地)
区域: 渤海/黄海 (36-40°N, 118-124°E)

前置条件: 同 download_era5_wind.py（需要 ~/.cdsapirc）
"""

import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "raw"
OUTPUT_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "era5_landmask.nc"

CDSAPIRC = Path.home() / ".cdsapirc"


def main():
    if not CDSAPIRC.exists():
        print("错误: 未找到 ~/.cdsapirc，请先配置（参见 download_era5_wind.py）")
        sys.exit(1)

    try:
        import cdsapi
    except ImportError:
        print("错误: 请先安装 cdsapi 包: pip install cdsapi")
        sys.exit(1)

    print("正在从 ERA5-Land 下载陆海掩膜...")
    print(f"  区域: 36-40°N, 118-124°E")
    print(f"  输出: {OUTPUT_FILE}")
    print()

    client = cdsapi.Client()

    client.retrieve(
        "reanalysis-era5-land",
        {
            "variable": ["land_sea_mask"],
            "year": ["2024"],
            "month": ["01"],
            "day": ["15"],
            "time": ["00:00"],
            "area": [40, 118, 36, 124],  # N, W, S, E
            "data_format": "netcdf",
        },
        str(OUTPUT_FILE),
    )

    print(f"陆海掩膜下载完成: {OUTPUT_FILE}")
    print(f"文件大小: {OUTPUT_FILE.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
