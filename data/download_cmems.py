#!/usr/bin/env python3
"""
下载 CMEMS 海流 + 海温数据
产品: GLOBAL_ANALYSISFORECAST_PHY_001_024
变量: uo (东向流速), vo (北向流速), thetao (海温)
区域: 渤海/黄海 (36-40°N, 118-124°E)
时段: 2024-01-15 ~ 2024-01-17 (48h)
"""

import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "raw"
OUTPUT_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "cmems_currents_sst.nc"

def main():
    try:
        import copernicusmarine
    except ImportError:
        print("错误: 请先安装 copernicusmarine 包")
        print("  pip install copernicusmarine")
        sys.exit(1)

    print("正在从 CMEMS 下载海流和海温数据...")
    print(f"  区域: 36-40°N, 118-124°E")
    print(f"  时段: 2024-01-15 ~ 2024-01-17")
    print(f"  变量: uo, vo, thetao")
    print(f"  输出: {OUTPUT_FILE}")
    print()

    try:
        copernicusmarine.subset(
            dataset_id="cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i",
            variables=["uo", "vo"],
            minimum_longitude=118.0,
            maximum_longitude=124.0,
            minimum_latitude=36.0,
            maximum_latitude=40.0,
            minimum_depth=0.49,
            maximum_depth=0.50,
            start_datetime="2024-01-15T00:00:00",
            end_datetime="2024-01-17T00:00:00",
            output_filename="cmems_currents.nc",
            output_directory=str(OUTPUT_DIR),
        )
        print("海流数据下载完成!")
    except Exception as e:
        print(f"海流下载失败: {e}")
        print("提示: 确保已登录 CMEMS，运行: copernicusmarine login")

    # 单独下载海温（可能在不同的 dataset_id）
    try:
        copernicusmarine.subset(
            dataset_id="cmems_mod_glo_phy-thetao_anfc_0.083deg_PT6H-i",
            variables=["thetao"],
            minimum_longitude=118.0,
            maximum_longitude=124.0,
            minimum_latitude=36.0,
            maximum_latitude=40.0,
            minimum_depth=0.49,
            maximum_depth=0.50,
            start_datetime="2024-01-15T00:00:00",
            end_datetime="2024-01-17T00:00:00",
            output_filename="cmems_sst.nc",
            output_directory=str(OUTPUT_DIR),
        )
        print("海温数据下载完成!")
    except Exception as e:
        print(f"海温下载失败: {e}")


if __name__ == "__main__":
    main()
