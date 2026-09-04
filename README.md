# ALmatchtool

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live-222?logo=github)](https://steven-hjj.github.io/almath)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 面向 Edexcel AL 数学考试刷题场景的双端应用：**学生端**用手机/电脑刷题，**教师端**用电脑出题与管理。

---

## 在线体验

| 入口 | 地址 | 说明 |
|------|------|------|
| 学生端 | [https://steven-hjj.github.io/almath](https://steven-hjj.github.io/almath) | 刷题、每日挑战、错题本、模拟考试 |
| 教师端 | （不对外公开） | 上传资料、解析 PDF、快速出题、投放题目 |

> 提示：请使用 `https://` 线上地址访问学生端，**不要双击本地 HTML 文件打开**，否则会出现数据不同步等兼容性问题。如遇页面显示异常，请按 `Ctrl + Shift + R`（Windows）或 `Cmd + Shift + R`（Mac）硬刷新。

---

## 功能亮点

### 学生端
- 按学科/章节筛选刷题
- 每日挑战，养成学习习惯
- 错题本自动收录，随时复习
- 模拟考试，计时作答
- 思维导图与公式手册辅助记忆

### 教师端
- 上传 PDF 资料自动解析题目
- 粘贴文本快速批量生成题目
- 草稿自动保存，刷新不丢
- 校对后一键投放学生端
- 教材与题目分类管理

---

## 快速开始

1. 打开 [学生端](https://steven-hjj.github.io/almath) 开始刷题。
2. 教师通过私有入口进入教师端，在「资料库」上传 PDF 或在「题目解析」粘贴文本出题。
3. 校对题目后点击「全部保存到题库」，再进入「已发布」投放到学生端。

---

## 技术栈

- 前端：原生 HTML / CSS / JavaScript（无需构建工具）
- 后端：Supabase（题库与用户数据管理）
- 部署：GitHub Pages
- 小程序：微信原生小程序（开发中）

---

## 项目结构

```text
.
├── index.html          # 学生端入口
├── admin/              # 教师端
│   └── index.html
├── data-P*.js          # 学科题目数据
├── db.js               # 数据与后端交互逻辑
├── pdf/                # 教材与示例 PDF
└── sw.js               # Service Worker（缓存支持）
```

---

## 说明

- 数学类题目已统一 Unicode 渲染，避免 `^`、`_` 残留。
- 教师端题目草稿保存在浏览器本地存储（localStorage），校对到一半可放心关闭页面。
- 正式微信小程序 AppID：`wx90d7339d3b4493e1`。

---

Maintained by [steven-hjj](https://github.com/steven-hjj).
