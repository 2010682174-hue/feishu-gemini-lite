const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelName = process.env.MODEL || 'gemini-1.5-pro';

// 初始化飞书 SDK
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// 飞书 Webhook 消息接收端点
app.post('/', async (req, res) => {
  // 1. 处理飞书 URL 验证挑战
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // 立即返回 200 给飞书，避免超时
  res.status(200).send('OK');

  try {
    const event = req.body.event;
    if (!event || !event.message) return;

    const message = event.message;
    if (message.message_type !== 'text') return;

    const content = JSON.parse(message.content);
    const userText = content.text;
    const openId = event.sender.sender_id.open_id;

    console.log(`收到来自 ${openId} 的消息: ${userText}`);

    // 2. 调用 Gemini，并应用 System Prompt (人设)
    const systemPrompt = process.env.SYSTEM_PROMPT || "你是一个高效的AI助手。";
    
    const model = genAI.getGenerativeModel({ 
      model: modelName,
      systemInstruction: systemPrompt // 完美生效的人设！
    });

    const result = await model.generateContent(userText);
    const response = await result.response;
    const replyText = response.text() || "Gemini 暂时没有返回内容。";

    // 3. 将回复通过飞书发回给用户
    await larkClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: replyText })
      }
    });

    console.log(`成功回复给 ${openId}`);
  } catch (err) {
    console.error('处理消息出错:', err);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Feishu Gemini Lite server is running on port ${PORT}`);
});
