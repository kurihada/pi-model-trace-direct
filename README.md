# pi-model-trace-api

Pi package for **ModelTrace** model attribution over a **raw API call** — the
probe carries no Pi system prompt, no `AGENTS.md`, no skills.

```
/model-trace-api                 # 直接弹选择框：先选模式，再选模型（默认当前对话模型）
/model-trace-api --both          # 模式已指定，只问模型
/model-trace-api openai/gpt-5.6-sol          # 模型已指定，只问模式
/model-trace-api openai/gpt-5.6-sol --both   # 全给定，不弹框，直接跑
```

**规则：参数里给了什么就不问什么。** 两个选择框的第二个列表，就是 `/model` 选择器里那批
（`ctx.scopedModels`），当前对话模型固定在第一位。

无界面环境（`pi -p`）不会弹框，直接按 `--raw` + 当前模型跑，所以脚本里也能用。

## 不阻塞对话

探针在**后台**跑。命令立刻返回，你可以继续对话；每完成一个探针发一条通知，全部结束后
把报告插入 transcript。

这是必须的，不是可选项：命令 handler 一旦阻塞，TUI 就不重绘 —— 进度、计时器、
甚至 Esc 取消全都渲染不出来。返回得越快，能看见的东西才越多。

每个探针有 5 分钟硬截止（`Promise.race` 一个普通定时器，不依赖 provider 是否老实响应
`AbortSignal`），所以接口不返回也不会把会话卡住。

## 为什么需要它

`@indexyz/pi-model-trace` 走的是 `pi -p --no-session --no-tools` 子进程，探针里
**仍然带着 Pi 的整个系统提示词**。而指纹库是在裸 API 调用上采出来的——系统提示词
一变，模型的数字分布就偏了，离每个存储的质心都更远，可能把一个就在眼前的模型判错。

这个包用 `ctx.modelRegistry.streamSimple(model, context, ...)`，context 是我们自己搭的：

```ts
// raw 模式：消息数组里只有 user
messages = [{ role: "user", content: challenge.prompt }]

// --pi 模式：多一条 system
messages = [{ role: "system", content: ctx.getSystemPrompt() }, { role: "user", ... }]
```

认证、base URL、Anthropic/OpenAI 格式差异都由 Pi 的 provider 层处理，所以**不用手写
HTTP，也不用填 API Key**——直接写 `provider/model` 就行。

`--both` 是同名挑战、同样的评分代码，唯一变量是 system message。所以两者的差值
就是 Pi 提示词的**实测代价**，而不是两个工具之间的噪声。

## 归因方法

与上游 ModelTrace 一致：三次探针各要 ~300 个 1..355 的整数，本地用内置指纹库
（`data/unified_bank.json`）打分。

指纹库当前包含 **24 个模型 / 6 个家族**：GPT 8、Claude 9、Kimi 3、Grok 2、Gemini 1、GLM 1。
（上游 ModelTrace 仓库自带的库只有 2 个家族，那里已经过时了。）

```
0.75 × 去除环境方向后的 Hellinger 模型中心相似度
+ 0.25 × 有序块数字序列特征
```

家族概率是该家族下各模型概率之和。

## 声明

- 结果是**指纹库内的闭集概率**。未收录的模型会被归到最相似的现有候选
- 探针会消耗目标模型的推理额度（3 次 × 每种模式）
- 算法、挑战生成器和指纹库移植自
  [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)（MIT，© 2026 xqy2006）

## 开发

```bash
npm install
npm run check      # checks.ts + tsc --noEmit
```

`checks.ts` 是一个无框架的自检，覆盖参数解析和模式对比的文案分支。
