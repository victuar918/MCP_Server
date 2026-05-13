import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { VertexAI } from '@google/vertexai';
import { OAuth2Client } from 'google-auth-library';

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. 환경 변수 및 기본 설정
// ==========================================
const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID || 'asterion-server'; // 오기입 수정 완료
const REGION_CLAUDE = 'asia-northeast3'; // Claude 4.6은 서울 리전
const REGION_GEMINI = 'global'; // Gemini 3.1 Pro는 Global 필수

// OAuth 설정 (GAS 및 Sheets 접근용)
const oauth2Client = new OAuth2Client(
process.env.GOOGLE_CLIENT_ID,
process.env.GOOGLE_CLIENT_SECRET,
process.env.GOOGLE_REDIRECT_URI || https://mcp-server-611151539232.asia-northeast3.run.app/auth/callback
);

// ==========================================
// 2. 페르소나 (시스템 프롬프트) 정의
// ==========================================
const SYSTEM_PROMPT_BTR = 당신은 ASTERION의 BTR 루브릭 엔진입니다. S-Class(97점 이상) 합의 전까지 어떤 결과도 확정하지 않으며, 논리적 완결성을 최우선으로 합니다... (기존 BTR 프롬프트 유지);

const SYSTEM_PROMPT_FREESTYLE = 당신은 지훈님의 완전한 자유분방 멀티플레이어 파트너이자 수석 아키텍트입니다. 격식과 BTR 룰을 모두 버리고, 지훈님의 시스템 개발, 코딩, 인프라 구축을 돕습니다. 파일 생성, 폴더 구조 설계, 자동 배포 스크립트 작성 등 파일 시스템 도구를 적극적으로 사용하여 '자동 빌더' 역할을 수행하십시오.;

// ==========================================
// 3. 파일 시스템 툴 정의 (The Hand)
// ==========================================
const fileSystemTools = [
{
name: 'write_file',
description: '지정된 경로에 파일(코드, 텍스트 등)을 생성하고 저장합니다.',
parameters: {
type: 'object',
properties: {
filePath: { type: 'string', description: '저장할 파일의 상대 또는 절대 경로 (예: ./src/index.js)' },
content: { type: 'string', description: '파일에 들어갈 내용' }
},
required: ['filePath', 'content']
}
},
{
name: 'make_directory',
description: '새로운 폴더를 생성합니다.',
parameters: {
type: 'object',
properties: {
dirPath: { type: 'string', description: '생성할 폴더 경로' }
},
required: ['dirPath']
}
},
{
name: 'read_file',
description: '서버에 있는 특정 파일의 내용을 읽어옵니다.',
parameters: {
type: 'object',
properties: {
filePath: { type: 'string', description: '읽어올 파일 경로' }
},
required: ['filePath']
}
},
{
name: 'list_files',
description: '특정 폴더 내의 파일 목록을 확인합니다.',
parameters: {
type: 'object',
properties: {
dirPath: { type: 'string', description: '조회할 폴더 경로 (기본값: .)' }
},
required: ['dirPath']
}
}
// 차후 여기에 BTR용 73개 도구(vedastro, gas 등)를 추가 매핑합니다.
];

// 툴 실행 핸들러
async function executeTool(name, args) {
try {
switch (name) {
case 'write_file':
await fs.writeFile(args.filePath, args.content, 'utf8');
return 성공: ${args.filePath} 파일이 생성/수정되었습니다.; case 'make_directory': await fs.mkdir(args.dirPath, { recursive: true }); return성공: ${args.dirPath} 폴더가 생성되었습니다.;
case 'read_file':
const content = await fs.readFile(args.filePath, 'utf8');
return content;
case 'list_files':
const files = await fs.readdir(args.dirPath);
return 목록: ${files.join(', ')}; default: return알 수 없는 도구입니다: ${name};
}
} catch (error) {
return 도구 실행 오류 (${name}): ${error.message};
}
}

// ==========================================
// 4. 메인 API: 채팅앱 연동 및 페르소나 스위칭
// ==========================================
app.post('/message', async (req, res) => {
const { prompt, modelName = 'claude' } = req.body;

// 헤더를 통한 지훈님 개인 앱 식별 (페르소나 스위칭)
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
// Vertex AI 초기화 (ADC 자동 적용)
const location = modelName === 'gemini' ? REGION_GEMINI : REGION_CLAUDE;
const vertexAI = new VertexAI({ project: PROJECT_ID, location: location });

const targetModel = modelName === 'gemini' ? 'gemini-3.1-pro-preview' : 'claude-sonnet-4-6';

// 모델 인스턴스화 및 툴 바인딩 (팔 해제 작전 적용)
const generativeModel = vertexAI.getGenerativeModel({
model: targetModel,
systemInstruction: { parts: [{ text: currentSystemPrompt }] },
tools: [{ functionDeclarations: fileSystemTools }] // AI가 직접 도구를 쥠
});

// AI에게 메시지 전송
const chat = generativeModel.startChat({});
const response = await chat.sendMessage([{ text: prompt }]);
const responseData = response.response;

// AI가 도구 사용을 결정했는지 확인 (Function Call)
if (responseData.functionCalls && responseData.functionCalls.length > 0) {
let toolResults = [];
for (const call of responseData.functionCalls) {
console.log(🛠️ AI가 도구 실행 중: ${call.name}); const result = await executeTool(call.name, call.args); toolResults.push({ name: call.name, result }); } // 도구 실행 결과를 다시 AI에게 던져서 최종 답변 생성 로직 (생략/단순화) return res.json({ reply:도구 실행 완료: ${JSON.stringify(toolResults)}, isFreestyle });
}

// 일반 텍스트 응답인 경우
const replyText = responseData.candidates[0].content.parts[0].text;
res.json({ reply: replyText, isFreestyle });

} catch (error) {
console.error("API Error:", error);
res.status(500).json({ error: error.message });
}
});

// ==========================================
// 5. OAuth 임시 엔드포인트 (Refresh Token 발급용)
// ==========================================
app.get('/auth', (req, res) => {
const authorizeUrl = oauth2Client.generateAuthUrl({
access_type: 'offline',
prompt: 'consent', // 반드시 consent를 넣어야 Refresh Token이 나옴
scope: [
'https://www.googleapis.com/auth/spreadsheets',
'https://www.googleapis.com/auth/script.projects'
 ],
});
res.redirect(authorizeUrl);
});

app.get('/auth/callback', async (req, res) => {
const code = req.query.code;
try {
const { tokens } = await oauth2Client.getToken(code);
res.send(&lt;h1&gt;인증 성공!&lt;/h1&gt; &lt;p&gt;아래의 Refresh Token을 복사하여 환경변수 &lt;b&gt;GOOGLE_REFRESH_TOKEN&lt;/b&gt;에 저장하십시오.&lt;/p&gt; &lt;textarea rows="5" cols="70" readonly&gt;${tokens.refresh_token}</textarea>
<p>이 창은 이제 닫으셔도 됩니다.</p>
`);
} catch (error) {
res.status(500).send('인증 중 오류 발생: ' + error.message);
}
});

// 서버 시작
app.listen(PORT, () => {
console.log(🔱 ASTERION MCP Server is running on port${PORT}`);
});