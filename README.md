# Lanwatch Doctor

局域网网络诊断工具 —— 让不懂技术的人也能快速定位网络故障。

## 版本

V2026.10.28

## 技术栈

- **前端**: React 19 + TypeScript + Vite
- **后端**: Rust + Tauri 2
- **路由追踪**: NextTrace（外部依赖）

## 核心功能

- 一键网络诊断（连通性 + 性能双通道）
- 网络状态实时面板
- 应用体验度量（百度/淘宝/腾讯延迟）
- 实时延迟图表
- 路由追踪可视化

## 开发

```bash
cd lanwatch-doctor
npm install
npx tauri dev
```

## 许可证

MIT
