/**
 * 火山方舟大模型评分
 * 输出两项分数：访客复述匹配分、全员语言能力分（完整度+流畅度）
 * 等级由编排层按配置阈值计算，模型只给分数与评语，降低出错面
 */
const config = require("../../config");

function buildPrompt(hostText, guests) {
  const guestLines = guests
    .map(
      (g, i) =>
        `访客${i + 1} userId=${g.userId} 昵称=${g.nickname}，复述转写文本：${
          g.text === "" ? "（无有效语音/静音）" : g.text
        }`
    )
    .join("\n");

  return `你是语音复述评分专家。下面是一轮“房主发言→访客复述”的转写文本，请严格按标准打分。

【房主原文转写】
${hostText === "" ? "（无有效语音）" : hostText}

${guestLines}

【打分标准】
1. matchScore（复述匹配分，0-${config.scoring.max}，仅访客）：对比该访客复述与房主原文的语义一致性，衡量关键信息点覆盖率与原意保留程度；允许措辞不同，只要语义一致即可给高分；信息遗漏、理解偏差、添加无关内容相应扣分。房主的 matchScore 设为 null。
2. languageScore（语言能力分，0-${config.scoring.max}，房主和访客都要打）：衡量语言表达的完整度与流畅度，包括逻辑连贯、语句通顺、用词准确、无语病断句、表达是否完整。此项与复述准确度无关，独立评分。
3. 无有效语音/静音者：访客 matchScore=0、languageScore=0。
4. comment：针对该参与者给一句不超过 50 字的简短中文评语，说明主要优点或扣分点。

【输出要求】
只输出一个 JSON 对象，不要输出任何解释或 markdown 代码块，结构如下：
{"scores":[{"userId":"...","matchScore":数字或null,"languageScore":数字,"comment":"..."}]}
数组必须包含房主和全部访客，共 ${guests.length + 1} 条；其中房主那条的 userId 固定写 "__HOST__"，matchScore 固定为 null；访客各条的 userId 用上面给出的真实值。`;
}

/** 从模型输出中提取 JSON（兼容被 ```json 包裹的情况） */
function parseScores(text, hostId) {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("模型未返回有效 JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed.scores)) throw new Error("评分 JSON 缺少 scores 数组");
  // 房主占位符替换为真实 hostId
  return parsed.scores.map((s) => {
    if (s.userId === "__HOST__") s.userId = hostId;
    return s;
  });
}

async function scoreByLLM(hostText, guests, hostId) {
  const apiKey = process.env.ARK_API_KEY;
  const modelId = process.env.ARK_MODEL_ID;
  if (!apiKey) throw new Error("缺少 ARK_API_KEY");
  if (!modelId) throw new Error("缺少 ARK_MODEL_ID，请在 .env 填入模型/接入点 ID");

  const resp = await fetch(`${process.env.ARK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: buildPrompt(hostText, guests) }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`方舟接口错误 ${resp.status}: ${errText.slice(-300)}`);
  }
  const data = await resp.json();
  const content = data.choices[0].message.content;
  return parseScores(content, hostId);
}

module.exports = { scoreByLLM };
