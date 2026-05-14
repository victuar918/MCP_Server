import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { VertexAI } from '@google-cloud/vertexai';
import { OAuth2Client } from 'google-auth-library';

const app = express();
app.use(cors());
app.use(express.json());

// Cloud Run 환경 최적화 (Health Check 및 프록시 신뢰)
app.set('trust proxy', true);

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'asterion-server';
const REGION_CLAUDE = 'asia-northeast3';
const REGION_GEMINI = 'global';

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

// ==========================================
// Cloud Run Health Check용 루트 (Timeout 에러 방지)
// ==========================================
app.get('/', (req, res) => {
  res.status(200).send('🔱 ASTERION MCP Server is running stable.');
});

// ==========================================
// 메인 AI 메시지 라우터
// ==========================================
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

// ==========================================
// Google OAuth 인증 라우터
// ==========================================
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `https://mcp-server-611151539232.asia-northeast3.run.app/auth/callback`;

  // 환경변수가 텅 비어있는지 화면에서 바로 확인하기 위한 방어 코드
  if (!clientId || !clientSecret) {
    return res.status(500).send(`
      <div style="padding: 20px; font-family: sans-serif;">
        <h2 style="color: red;">🚨 환경변수 누락 에러!</h2>
        <p>Cloud Run에 환경변수가 전달되지 않았습니다. 수동 배포 시 변수가 초기화되었습니다.</p>
        <ul>
          <li><b>GOOGLE_CLIENT_ID:</b> ${clientId ? '존재함' : '비어있음 (undefined)'}</li>
          <li><b>GOOGLE_CLIENT_SECRET:</b> ${clientSecret ? '존재함' : '비어있음 (undefined)'}</li>
        </ul>
      </div>
    `);
  }

  try {
    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
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
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `https://mcp-server-611151539232.asia-northeast3.run.app/auth/callback`;
  
  const code = req.query.code;
  try {
    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`
      <div style="padding: 20px; font-family: sans-serif;">
        <h2 style="color: green;">✅ 인증 성공!</h2>
        <p>아래 Refresh Token을 복사하여 <b>GOOGLE_REFRESH_TOKEN</b> 환경변수에 넣으세요.</p>
        <textarea rows="5" cols="70" readonly>${tokens.refresh_token}</textarea>
      </div>
    `);
  } catch (error) {
    res.status(500).send('인증 오류: ' + error.message);
  }
});

// ==========================================
// 서버 실행 (단 한 번만 호출, 0.0.0.0 바인딩)
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔱 ASTERION MCP Server is running on port ${PORT}`);
});
