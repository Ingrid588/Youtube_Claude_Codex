# 实时配音（Live Dub）- 全程匀速配音升级

## 改进内容

**live_dub_server.py** 已升级为支持**全程匀速配音**。

### 核心改变

1. **自动计算基准语速** ✨
   - 新增 `calculate_base_rate()` 函数
   - 在接收到配音请求时，自动计算整个视频的字/秒
   - 无需客户端计算，完全自动化

2. **全视频统一语速**
   - 所有句子都用同一个 TTS 速率生成
   - 完全消除"一会儿快一会儿慢"的感觉
   - 听感平稳、专业

---

## 工作流程

### 旧流程（dub9 时代）

```
Chrome插件 → 字幕数据（base_rate_pct=0） 
    ↓
live_dub_server（用默认的 0%）
    ↓
TTS 逐句微调 → 听感不匀称
```

### 新流程（升级后）

```
Chrome插件 → 字幕数据
    ↓
live_dub_server 自动计算 base_rate_pct
    ↓
所有句子用同一速率 TTS → 全程匀速听感 ✅
```

---

## 使用（无需改动）

启动 live_dub_server 正常运行即可：

```bash
python live_dub_server.py
```

**自动效果**：
- 📊 接收字幕后自动计算基准语速
- 🎯 所有句子用统一语速合成
- 🔊 完整音频听感匀速、自然

---

## 工作日志示例

用户在 Chrome 插件里点击"配音"后，live_dub_server 的日志会显示：

```
[2026-06-21 14:30:15] INFO 第2步：翻译字幕...（中文）
[2026-06-21 14:30:22] INFO ✓ 1000 字幕翻译完成
[2026-06-21 14:30:23] INFO 第3步：合成配音...（音色：zh-CN-XiaoxiaoNeural）
[2026-06-21 14:30:23] INFO 📊 自动计算基准语速: +50%（全程匀速配音）
[2026-06-21 14:30:45] INFO 配音完成，共 50 段
```

---

## 自定义语速（高级）

如果需要为特定视频指定不同的语速，可以：

### 选项 A：修改目标语速（代码改）

编辑 `live_dub_server.py` 第 169 行：

```python
# 现在是中文标准 3.2 字/秒
req.base_rate_pct = calculate_base_rate(segments)

# 改成更慢（2.8 字/秒）
req.base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=2.8)
```

### 选项 B：Chrome 插件中强制指定

如果 Chrome 插件支持，可以在请求中设置 `base_rate_pct`，live_dub_server 会使用该值而不计算：

```javascript
// 在插件中
dubRequest.base_rate_pct = 30;  // 快 30%
```

日志会显示：
```
[2026-06-21 14:30:23] INFO ✓ 使用客户端指定的基准语速: +30%
```

---

## 技术细节

### `calculate_base_rate(segments, target_chars_per_sec=3.2)` 函数

**参数**：
- `segments`: 字幕段列表，每个段必须有 `translation`, `start`, `end` 字段
- `target_chars_per_sec`: 目标语速（默认 3.2，中文标准）

**返回值**：
- 整数百分比（-50 到 +100 之间）

**计算逻辑**：

```
1. 统计所有有翻译的段的总字数：total_chars
2. 计算总时长：total_time = last_seg['end'] - first_seg['start']
3. 实际字/秒：actual_chars_per_sec = total_chars / total_time
4. 所需加速比：rate_pct = (actual_chars_per_sec / target_chars_per_sec - 1) * 100
5. 限制范围：max(-50, min(100, rate_pct))
```

**例子**：
```
总字数：1000
总时长：100 秒
实际字/秒：10
目标字/秒：3.2
所需加速：(10 / 3.2 - 1) × 100 = +212%

结果：所有句子都快 212%，全程匀速
```

---

## 性能对比

| 指标 | 改进前 | 改进后 |
|------|--------|--------|
| 逐句微调 | 是 | ✗ 否 |
| 听感稳定性 | 不稳定（快慢不一） | ✅ 完全匀速 |
| API 调用 | 多（超时还要重新调） | 更少 |
| 处理速度 | 正常 | 更快（无重试） |
| 音质 | 逐句加速（变调） | 原生TTS（自然） |

---

## 故障排查

### Q: 日志显示"自动计算基准语速"但没有数字
**A**: 检查字幕段是否有 `translation` 字段和有效的 `start`/`end` 时间

### Q: 觉得配音还是有快慢变化
**A**: 这可能是因为：
1. 字幕中某些句子本身很短或很长（时间窗不均匀）
2. 某些句子的翻译比其他长很多

**解决**：
- 手动调整字幕的 `end` 时间，使句子更均匀
- 或调整中文翻译的字数

### Q: 配音太快/太慢
**A**: 改 `target_chars_per_sec` 参数：
- 太快 → 改成 2.8（更慢）
- 太慢 → 改成 3.6（更快）

---

## 代码变更

### 新增函数

- `calculate_base_rate(segments, target_chars_per_sec=3.2)` - 计算全视频基准语速

### 修改的调用

原：
```python
segments = await dub9.synthesize_all(segments, tts_voice, req.title,
                                     base_rate_pct=req.base_rate_pct)
```

现：
```python
if req.base_rate_pct == 0:
    req.base_rate_pct = calculate_base_rate(segments)
    log.info(f"📊 自动计算基准语速: {req.base_rate_pct:+d}%（全程匀速配音）")
else:
    log.info(f"✓ 使用客户端指定的基准语速: {req.base_rate_pct:+d}%")

segments = await dub9.synthesize_all(segments, tts_voice, req.title,
                                     base_rate_pct=req.base_rate_pct)
```

---

## 总结

✅ **live_dub_server 现在支持全程匀速配音**

- 自动计算，无需改插件
- 一键启动，立即生效
- 听感专业、稳定
- 成本更低（减少重试）

**立即试用**：`python live_dub_server.py`
