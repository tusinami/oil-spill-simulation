#!/usr/bin/env python3
"""
预处理脚本: 将下载的 NetCDF 数据转换为紧凑 JSON 网格格式
供前端 JavaScript 直接使用

输入: data/raw/*.nc
输出: data/processed/*.json

JSON 格式:
{
  "lat": [36.0, 36.083, ...],          # 升序纬度数组
  "lon": [118.0, 118.083, ...],        # 升序经度数组
  "time_hours": [0, 1, 2, ..., 48],    # 自起始时刻的小时数 (仅时变场)
  "shape": [nTime, nLat, nLon],        # 数据维度
  "varName": [v1, v2, ...],            # 展平的 row-major 数组
}

索引方式: data[t * nLat * nLon + lat_i * nLon + lon_i]
"""

import json
import sys
from pathlib import Path

import numpy as np

RAW_DIR = Path(__file__).parent / "raw"
OUT_DIR = Path(__file__).parent / "processed"
OUT_DIR.mkdir(exist_ok=True)

DECIMALS = 3  # 数值精度（小数位）


def load_dataset(filepath):
    """加载 NetCDF 文件"""
    import xarray as xr
    ds = xr.open_dataset(filepath)
    return ds


def get_coords(ds):
    """提取纬度和经度坐标（统一处理不同命名）"""
    # 纬度
    for name in ['latitude', 'lat', 'y']:
        if name in ds.coords:
            lat = ds[name].values.astype(float)
            break
    else:
        raise ValueError(f"未找到纬度坐标，可用坐标: {list(ds.coords)}")

    # 经度
    for name in ['longitude', 'lon', 'x']:
        if name in ds.coords:
            lon = ds[name].values.astype(float)
            break
    else:
        raise ValueError(f"未找到经度坐标，可用坐标: {list(ds.coords)}")

    # 确保升序排列
    lat_ascending = lat[0] < lat[-1] if len(lat) > 1 else True
    lon_ascending = lon[0] < lon[-1] if len(lon) > 1 else True

    return lat, lon, lat_ascending, lon_ascending


def extract_variable(ds, var_name, lat_ascending, squeeze_depth=True):
    """提取变量数据，处理深度维度和排序"""
    arr = ds[var_name].values

    # 如果有深度维度，取表层
    if squeeze_depth:
        # 检查是否有 depth 维度
        for dim_name in ['depth', 'level', 'z']:
            if dim_name in ds[var_name].dims:
                # 取第一个深度层（表层）
                depth_idx = list(ds[var_name].dims).index(dim_name)
                arr = np.take(arr, 0, axis=depth_idx)
                break

    # 如果纬度降序，翻转
    if not lat_ascending:
        lat_dim = -2  # 倒数第二个维度是 lat
        arr = np.flip(arr, axis=lat_dim)

    # 替换 NaN
    arr = np.nan_to_num(arr, nan=0.0)

    return arr


def process_time_varying(nc_file, var_names, output_name):
    """处理时变场（海流、风、海温）"""
    print(f"  加载 {nc_file.name} ...")
    ds = load_dataset(nc_file)
    lat, lon, lat_asc, lon_asc = get_coords(ds)

    # 排序纬度
    if not lat_asc:
        lat = lat[::-1]

    # 提取时间
    time_dim = None
    for name in ['time', 'valid_time']:
        if name in ds.dims:
            time_dim = name
            break

    if time_dim is None:
        raise ValueError(f"未找到时间维度，可用维度: {list(ds.dims)}")

    t0 = ds[time_dim].values[0]
    time_values = ds[time_dim].values
    time_hours = ((time_values - t0) / np.timedelta64(1, 'h')).astype(float)

    result = {
        "lat": np.round(lat, 4).tolist(),
        "lon": np.round(lon, 4).tolist(),
        "time_hours": [round(float(t), 2) for t in time_hours],
        "shape": [len(time_hours), len(lat), len(lon)],
    }

    for var in var_names:
        if var not in ds:
            print(f"    警告: 变量 {var} 不在数据集中，跳过")
            continue
        arr = extract_variable(ds, var, lat_asc)
        # 确保是 3D (time, lat, lon)
        if arr.ndim == 2:
            arr = arr[np.newaxis, :, :]
        result[var] = np.round(arr, DECIMALS).flatten().tolist()
        print(f"    {var}: shape={arr.shape}, range=[{arr.min():.3f}, {arr.max():.3f}]")

    out_file = OUT_DIR / f"{output_name}_grid.json"
    with open(out_file, 'w') as f:
        json.dump(result, f, separators=(',', ':'))

    size_kb = out_file.stat().st_size / 1024
    print(f"    输出: {out_file.name} ({size_kb:.0f} KB)")
    ds.close()


def process_landmask(nc_file):
    """处理静态陆海掩膜"""
    print(f"  加载 {nc_file.name} ...")
    ds = load_dataset(nc_file)
    lat, lon, lat_asc, lon_asc = get_coords(ds)

    if not lat_asc:
        lat = lat[::-1]

    # 找 lsm 变量
    lsm_var = None
    for name in ['lsm', 'land_sea_mask', 'LSM']:
        if name in ds:
            lsm_var = name
            break

    if lsm_var is None:
        print(f"    警告: 未找到 lsm 变量，可用变量: {list(ds.data_vars)}")
        # 尝试第一个变量
        lsm_var = list(ds.data_vars)[0]
        print(f"    使用变量: {lsm_var}")

    arr = ds[lsm_var].values
    if not lat_asc:
        arr = np.flip(arr, axis=-2)

    # 挤压多余维度 (time, etc.)
    while arr.ndim > 2:
        arr = arr[0]

    arr = np.nan_to_num(arr, nan=1.0)  # NaN 视为陆地

    result = {
        "lat": np.round(lat, 4).tolist(),
        "lon": np.round(lon, 4).tolist(),
        "shape": [len(lat), len(lon)],
        "lsm": np.round(arr, DECIMALS).flatten().tolist(),
    }

    out_file = OUT_DIR / "landmask_grid.json"
    with open(out_file, 'w') as f:
        json.dump(result, f, separators=(',', ':'))

    land_pct = (arr > 0.5).mean() * 100
    size_kb = out_file.stat().st_size / 1024
    print(f"    lsm: shape={arr.shape}, 陆地比例={land_pct:.1f}%")
    print(f"    输出: {out_file.name} ({size_kb:.0f} KB)")
    ds.close()


def main():
    try:
        import xarray  # noqa
    except ImportError:
        print("错误: 请先安装依赖: pip install -r requirements.txt")
        sys.exit(1)

    print("=" * 50)
    print("NetCDF → JSON 网格数据预处理")
    print("=" * 50)

    # 1. CMEMS 海流
    cmems_cur = RAW_DIR / "cmems_currents.nc"
    if cmems_cur.exists():
        print("\n[1/4] 处理 CMEMS 海流数据...")
        process_time_varying(cmems_cur, ["uo", "vo"], "current")
    else:
        print(f"\n[1/4] 跳过: {cmems_cur} 不存在")

    # 2. CMEMS 海温
    cmems_sst = RAW_DIR / "cmems_sst.nc"
    if cmems_sst.exists():
        print("\n[2/4] 处理 CMEMS 海温数据...")
        process_time_varying(cmems_sst, ["thetao"], "temperature")
    else:
        print(f"\n[2/4] 跳过: {cmems_sst} 不存在")

    # 3. ERA5 风场
    era5_wind = RAW_DIR / "era5_wind.nc"
    if era5_wind.exists():
        print("\n[3/4] 处理 ERA5 风场数据...")
        process_time_varying(era5_wind, ["u10", "v10"], "wind")
    else:
        print(f"\n[3/4] 跳过: {era5_wind} 不存在")

    # 4. 陆海掩膜
    landmask = RAW_DIR / "era5_landmask.nc"
    if landmask.exists():
        print("\n[4/4] 处理陆海掩膜...")
        process_landmask(landmask)
    else:
        print(f"\n[4/4] 跳过: {landmask} 不存在")

    # 汇总
    print("\n" + "=" * 50)
    print("处理完成。生成的文件:")
    total_size = 0
    for f in sorted(OUT_DIR.glob("*.json")):
        size = f.stat().st_size / 1024
        total_size += size
        print(f"  {f.name}: {size:.0f} KB")
    print(f"  总计: {total_size:.0f} KB")


if __name__ == "__main__":
    main()
