const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelName = process.env.MODEL || 'gemini-1.5-pro';
const systemPrompt = process.env.SYSTEM_PROMPT || "你是一个高效的AI助手。";

// 初始化飞书 SDK
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// 用于保存每个用户对话历史的内存缓存 { openId: [ {role, parts}, ... ] }
const userSessions = new Map();

app.post('/', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  res.status(200).send('OK');

  try {
    const event = req.body.event;
    if (!event || !event.message) return;

    const message = event.message;
    if (message.message_type !== 'text') return;

    const content = JSON.parse(message.content);
    const userText = content.text.trim();
    const openId = event.sender.sender_id.open_id;

    console.log(`收到来自 ${openId} 的消息: ${userText}`);

    // 1. 检查用户是否输入了清除上下文的指令
    const resetCommands = ['#reset', '/clear', '重置', '清空记忆', '清除上下文'];
    if (resetCommands.includes(userText.toLowerCase())) {
      userSessions.delete(openId); // 清除该用户的历史记录
      await sendFeishuMessage(openId, "🧹 已经为您清除了所有对话上下文，我们可以重新开始啦！");
      return;
    }

    // 2. 获取或初始化该用户的对话历史
    if (!userSessions.has(openId)) {
      userSessions.set(openId, []);
    }
    const history = userSessions.get(openId);

    // 3. 初始化带人设 (System Instruction) 的 Gemini 模型
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      systemInstruction: systemPrompt 
    });

    // 4. 创建带历史记录的 Chat 会话
    const chat = model.startChat({
      history: history,
    });

    // 5. 发送消息并获取回复
    const result = await chat.sendMessage(userText);
    const response = await result.response;
    const replyText = response.text() || "Gemini 暂时没有返回内容。";

    // 6. 更新该用户的聊天历史到缓存中
    // 获取最新的完整的历史记录并保存
    const updatedHistory = await chat.getHistory();
    userSessions.set(openId, updatedHistory);

    // 7. 发送回复给飞书用户
    await sendFeishuMessage(openId, replyText);
    console.log(`成功回复给 ${openId}`);

  } catch (err) {
    console.error('处理消息出错:', err);
  }
});

// 封装一个发送飞书消息的公共函数
async function sendFeishuMessage(openId, text) {
  await larkClient.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text: text })
    }
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Feishu Gemini Lite server with session is running on port ${PORT}`);
});
