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
    const msgType = message.message_type; 
    const openId = event.sender.sender_id.open_id;
    const messageId = message.message_id;

    if (!userSessions.has(openId)) {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
      userSessions.set(openId, {
        chat: model.startChat({ history: [] }),
        pendingImage: null 
      });
    }
    const session = userSessions.get(openId);

    if (msgType === 'text') {
      const content = JSON.parse(message.content);
      const userText = content.text.trim();
      
      const resetCommands = ['#reset', '/clear', '重置', '清空记忆', '清除上下文'];
      if (resetCommands.includes(userText.toLowerCase())) {
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
        session.chat = model.startChat({ history: [] });
        session.pendingImage = null;
        await sendFeishuMessage(openId, "🧹 已经为您清除了所有对话上下文和暂存图片！");
        return;
      }

      if (session.pendingImage) {
        console.log(`用户 ${openId} 补充了图片需求: ${userText}`);
        await sendFeishuMessage(openId, "收到需求，Gemini 正在结合图片处理中...");

        const imagePart = {
          inlineData: {
            data: session.pendingImage.base64,
            mimeType: session.pendingImage.mimeType
          }
        };

        const result = await session.chat.sendMessage([userText, imagePart]);
        const replyText = result.response.text() || "Gemini 没返回内容。";

        session.pendingImage = null;

        await sendFeishuMessage(openId, replyText);
        return;
      }

      console.log(`收到文本: ${userText}`);
      const result = await session.chat.sendMessage(userText);
      await sendFeishuMessage(openId, result.response.text() || "Gemini 没返回内容。");

    } 
    else if (msgType === 'image') {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key;

      console.log(`收到图片, 正在下载, image_key: ${imageKey}`);

      const imageResponse = await larkClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' }
      });

      // 转换为 Buffer
      const imageBuffer = await streamToBuffer(imageResponse);
      const imageBase64 = imageBuffer.toString('base64');

      session.pendingImage = {
        base64: imageBase64,
        mimeType: "image/jpeg"
      };

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

// 全兼容的转换函数
async function streamToBuffer(input) {
  if (!input) throw new Error("输入对象为空");
  console.log("飞书资源返回的原始对象 keys:", Object.keys(input));

  if (Buffer.isBuffer(input)) return input;
  if (input.fileBuffer) return Buffer.from(input.fileBuffer);
  if (input.data) return Buffer.from(input.data);
  if (input.file) return Buffer.from(input.file);
  if (input.body) return await streamToBuffer(input.body);

  if (typeof input.on === 'function') {
    return new Promise((resolve, reject) => {
      const chunks = [];
      input.on('data', (chunk) => chunks.push(chunk));
      input.on('end', () => resolve(Buffer.concat(chunks)));
      input.on('error', (err) => reject(err));
    });
  }

  if (typeof input.arrayBuffer === 'function') {
    const ab = await input.arrayBuffer();
    return Buffer.from(ab);
  }

  if (input instanceof ArrayBuffer) return Buffer.from(input);

  throw new Error("无法识别的飞书资源返回格式，Keys: " + JSON.stringify(Object.keys(input)));
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
