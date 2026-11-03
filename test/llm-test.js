/* 真实 LLM 链路验证：用测试文本验证模型调用与 JSON 结构 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const { scoreByLLM } = require("../server/ai/llm");

const out = [];
const rec = (s) => {
  out.push(s);
  fs.writeFileSync(path.join(__dirname, "llm-result.log"), out.join("\n"), "utf8");
};

(async () => {
  rec("模型ID: " + process.env.ARK_MODEL_ID);
  const hostText = "今天天气很好，我们下午三点去公园散步，记得带一把伞，可能会下雨。";
  const guests = [
    { userId: "g1", nickname: "访客一", text: "今天天气不错，下午三点我们去公园走走，别忘了带伞，可能要下雨。" },
    { userId: "g2", nickname: "访客二", text: "明天要开会，我准备了很多资料。" },
  ];
  try {
    const r = await scoreByLLM(hostText, guests, "host1");
    rec("LLM 返回 " + r.length + " 条：");
    rec(JSON.stringify(r, null, 2));
    rec("PASS");
  } catch (e) {
    rec("LLM 调用失败: " + e.message);
    rec("FAIL");
  }
})();
