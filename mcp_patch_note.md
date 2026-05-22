app.all('/mcp',requireMcpAuth,async(req,res)=>{
  if(req.method==='OPTIONS'){res.setHeader('Allow','GET, POST, DELETE, OPTIONS');return res.status(204).end();}
  if(req.method==='DELETE')return res.status(200).json({jsonrpc:'2.0'});
  const body=req.method==='GET'?null:req.body,id=body?.id??null,method=body?.method;
  const params=body?.params; // ★ fix: params 명시 선언
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r}),err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try{
    if(req.method==='GET')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.9.1'}});
    if(!body)return err(-32700,'Parse error');
    if(method==='initialize')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.9.1'}});
    if(method==='notifications/initialized')return res.status(200).json({jsonrpc:'2.0'});
    if(method==='tools/list')return ok({tools:toolList});
    if(method==='tools/call'){const r=await executeTool(params?.name,params?.arguments||{});return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});}
    if(method==='ping')return ok({});
    return err(-32601,`Not found: ${method}`);
  }catch(e){return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
});