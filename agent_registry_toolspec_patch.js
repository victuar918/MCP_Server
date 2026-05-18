  // ★ Agent Registry 직접 조회
  if(n==='agent_registry_list'){
    const loc=a.location||GCP_REGION,res={};
    const r1=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services`,{headers:{Authorization:`Bearer ${tok}`}});
    const t1=await r1.text();
    res[loc]={status:r1.status,ok:r1.ok,data:r1.ok?(()=>{try{return JSON.parse(t1);}catch{return t1;}})():t1};
    if(loc!=='global'){const r2=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/global/services`,{headers:{Authorization:`Bearer ${tok}`}});const t2=await r2.text();res['global']={status:r2.status,ok:r2.ok,data:r2.ok?(()=>{try{return JSON.parse(t2);}catch{return t2;}})():t2};}
    return res;
  }

  // ★ Agent Registry 직접 등록 (TOOL_SPEC 타입 — ALL_TOOLS 인라인 포함)
  if(n==='agent_registry_register'){
    const loc=a.location||GCP_REGION;
    const endpointUrl=a.endpoint_url||`${MCP_URL}/mcp`;
    const displayName=a.display_name||'ASTERION AI Evolution Engine';
    const serviceId=a.service_id||'asterion-mcp';

    // 기존 서비스 삭제 (존재하면)
    const delR=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services/${serviceId}`,{method:'DELETE',headers:{Authorization:`Bearer ${tok}`}});
    if(delR.ok||delR.status===404) console.log(`[AgentRegistry] 기존 서비스 삭제: ${delR.status}`);

    // ALL_TOOLS → Agent Registry toolSpec 형식 변환
    const toolSpec = {
      tools: ALL_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    };

    const body={
      displayName,
      interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],
      mcpServerSpec:{type:'TOOL_SPEC',toolSpec}
    };
    console.log(`[AgentRegistry] POST ${loc}/services?serviceId=${serviceId} — TOOL_SPEC (${ALL_TOOLS.length}개 도구)`);
    const r=await fetch(
      `https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services?serviceId=${serviceId}`,
      {method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(body)}
    );
    const text=await r.text();
    let parsed; try{parsed=JSON.parse(text);}catch{parsed=text;}
    if(r.ok&&parsed.name){
      let op=parsed;
      for(let i=0;i<15&&!op.done;i++){
        await new Promise(res=>setTimeout(res,2000));
        const pr=await fetch(`https://agentregistry.googleapis.com/v1alpha/${op.name}`,{headers:{Authorization:`Bearer ${tok}`}});
        if(pr.ok)op=await pr.json();
      }
      return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,tools_count:ALL_TOOLS.length,operation_done:op.done,operation_error:op.error||null,result:op.response||op};
    }
    return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,response:parsed};
  }