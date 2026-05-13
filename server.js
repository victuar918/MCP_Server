import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { VertexAI } from '@google-cloud/vertexai'; // <-- 이 부분이 수정되었습니다.
import { OAuth2Client } from 'google-auth-library';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'asterion-server';
const REGION_CLAUDE = 'asia-northeast3';
const REGION_GEMINI = 'global';

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `https://mcp-server-611151539232.asia-northeast3.run.app/auth/callback`
);

const SYSTEM_PROMPT_BTR = `당신은 ASTERION의 BTR 루브릭 엔진입니다. S-Class(97점 이상) 합의 전까지 어떤 결과도 확정하지 않으며, 논리적 완결성을 최우선으로 합니다.`;
const SYSTEM_PROMPT_FREESTYLE = `당신은 지훈님의 완전한 자유분방 멀티플레이어 파트너이자 수석 아키텍트입니다. 파일 생성, 폴더 구조 설계 등 파일 시스템 도구를 적극적으로 사용하여 '자동 빌더' 역할을 수행하십시오.`;

const fileSystemTools = [
  {
    name: 'write_file',
    description: '지정된 경로에 파일(코드, 텍스트 등)을 생성하고 저장합니다.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['filePath', 'content']
    }
  },
  {
    name: 'read_file',
    description: '서버에 있는 특정 파일의 내용을 읽어옵니다.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' }
      },
      required: ['filePath']
    }
  }
];

async function executeTool(name, args) {
  try {
    if (name === 'write_file') {
      await fs.writeFile(args.filePath, args.content, 'utf8');
      return `성공: ${args.filePath} 파일이 생성되었습니다.`;
    } else if (name === 'read_file') {
      return await fs.readFile(args.filePath, 'utf8');
    }
    return `알 수 없는 도구: ${name}`;
  } catch (error) {
    return `도구 실행 오류: ${error.message}`;
  }
}

app.post('/message', async (req, res) => {
  const { prompt, modelName = 'claude' } = req.body;
  const clientApp = req.headers['x-jihoon-app'];
  const accessMode = req.headers['x-access-mode'];
  
  let currentSystemPrompt = SYSTEM_PROMPT_BTR;
  let isFreestyle = false;

  if (clientApp === 'ASTERION-CHATS' && accessMode === 'Freestyle') {
    currentSystemPrompt = SYSTEM_PROMPT_FREESTYLE;
    isFreestyle = true;
    console.log("🚀 [System] 지훈님 전용 자유분방 모드 활성화");
  }

  try {
    const location = modelName === 'gemini' ? REGION_GEMINI : REGION_CLAUDE;
    const vertexAI = new VertexAI({ project: PROJECT_ID, location: location });
    const targetModel = modelName === 'gemini' ? 'gemini-3.1-pro-preview' : 'claude-sonnet-4-6';
    
    const generativeModel = vertexAI.getGenerativeModel({
      model: targetModel,
      systemInstruction: { parts: [{ text: currentSystemPrompt }] },
      tools: [{ functionDeclarations: fileSystemTools }]
    });

    const chat = generativeModel.startChat({});
    const response = await chat.sendMessage([{ text: prompt }]);
    const responseData = response.response;

    if (responseData.functionCalls && responseData.functionCalls.length > 0) {
      let toolResults = [];
      for (const call of responseData.functionCalls) {
        const result = await executeTool(call.name, call.args);
        toolResults.push({ name: call.name, result });
      }
      return res.json({ reply: `도구 실행 완료: ${JSON.stringify(toolResults)}`, isFreestyle });
    }

    const replyText = responseData.candidates[0].content.parts[0].text;
    res.json({ reply: replyText, isFreestyle });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// server.js 의 /auth 라우터 부분을 아래처럼 교체하시면 에러 원인을 화면에 띄워줍니다.

app.get('/auth', (req, res) => {
  // 환경변수 누락 체크 로직 추가
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(`
      <h1>환경변수 누락 에러!</h1>
      <p>Cloud Run 환경변수에 <b>GOOGLE_CLIENT_ID</b> 또는 <b>GOOGLE_CLIENT_SECRET</b>가 비어있습니다.</p>
      <p>현재 인식된 ID: ${process.env.GOOGLE_CLIENT_ID ? '존재함' : '없음'}</p>
    `);
  }

  try {
    const authorizeUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.projects'],
    });
    res.redirect(authorizeUrl);
  } catch (error) {
    res.status(500).send('URL 생성 오류: ' + error.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`<h1>인증 성공!</h1><p>Refresh Token: ${tokens.refresh_token}</p>`);
  } catch (error) {
    res.status(500).send('인증 오류: ' + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`🔱 ASTERION MCP Server is running on port ${PORT}`);
});
