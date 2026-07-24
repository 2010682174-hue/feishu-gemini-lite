const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelName = process.env.MODEL || 'gemini-1.5-pro';
const systemPrompt = process.env.SYSTEM_PROMPT || "你是一个高效的AI多模态助手。";

const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// 用户会话缓存 
// 结构: { openId: { chat, pendingImage: { base64, mimeType } } }
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
    const msgType = message.message_type; // 'text' 或 'image'
    const openId = event.sender.sender_id.open_id;
    const messageId = message.message_id;

    // 初始化用户的会话结构
    if (!userSessions.has(openId)) {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
      userSessions.set(openId, {
        chat: model.startChat({ history: [] }),
        pendingImage: null // 用于暂存等待用户输入的图片
      });
    }
    const session = userSessions.get(openId);

    // 1. 处理文本消息
    if (msgType === 'text') {
      const content = JSON.parse(message.content);
      const userText = content.text.trim();
      
      const resetCommands = ['#reset', '/clear', '重置', '清空记忆', '清除上下文'];
      if (resetCommands.includes(userText.toLowerCase())) {
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
        session.chat = model.startChat({ history: [] });
        session.pendingImage = null; // 清空暂存图
        await sendFeishuMessage(openId, "🧹 已经为您清除了所有对话上下文和暂存图片！");
        return;
      }

      // 检查当前用户是否处于“刚发了图片，正在等待输入需求”的状态
      if (session.pendingImage) {
        console.log(`用户 ${openId} 补充了图片需求: ${userText}`);
        await sendFeishuMessage(openId, "收到需求，Gemini 正在结合图片处理中...");

        // 组装暂存的图片和用户刚发的文字
        const imagePart = {
          inlineData: {
            data: session.pendingImage.base64,
            mimeType: session.pendingImage.mimeType
          }
        };

        // 发送给 Gemini 并在对话中保留这一轮
        const result = await session.chat.sendMessage([userText, imagePart]);
        const replyText = result.response.text() || "Gemini 没返回内容。";

        // 处理完毕，清空暂存图片
        session.pendingImage = null;

        await sendFeishuMessage(openId, replyText);
        return;
      }

      // 普通纯文本对话
      console.log(`收到文本: ${userText}`);
      const result = await session.chat.sendMessage(userText);
      await sendFeishuMessage(openId, result.response.text() || "Gemini 没返回内容。");

    } 
    // 2. 处理图片消息
    else if (msgType === 'image') {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key;

      console.log(`收到图片, 正在下载, image_key: ${imageKey}`);

      // 下载飞书图片
      const imageResponse = await larkClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' }
      });

      const imageBuffer = await streamToBuffer(imageResponse);
      const imageBase64 = imageBuffer.toString('base64');

      // 将图片暂存到用户会话中
      session.pendingImage = {
        base64: imageBase64,
        mimeType: "image/jpeg"
      };

      // 提示用户输入需求
      await sendFeishuMessage(openId, "收到图片，请说明需求（直接回复文字即可）~");
    }

  } catch (err) {
    console.error('❌ 运行出错:', err);
    try {
      const errorDetail = err.message || JSON.stringify(err);
      await sendFeishuMessage(
        req.body.event.sender.sender_id.open_id, 
        `⚠️ 运行出错：\n${errorDetail.substring(0, 200)}`
      );
    } catch (e) {}
  }
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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
  console.log(`Server is running on port ${PORT}`);
});
