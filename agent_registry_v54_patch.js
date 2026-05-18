  // ★ Agent Registry 직접 등록 — v5.4: content 필드 사용 (toolSpec 아님)
  if(n==='agent_registry_register'){
    const loc=a.location||GCP_REGION;
    const endpointUrl=a.endpoint_url||`${MCP_URL}/mcp`;
    const displayName=a.display_name||'ASTERION AI Evolution Engine';
    const serviceId=a.service_id||'asterion-mcp';
    // 기존 서비스 삭제
    const delR=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services/${serviceId}`,{method:'DELETE',headers:{Authorization:`Bearer ${tok}`}});
    console.log(`[AgentRegistry] 기존 삭제: ${delR.status}`);
    // Discovery API 확인: McpServerSpec.type=TOOL_SPEC 일 때 content 필드에 tools 배열
    // Tool 스키마: {name, description} (inputSchema 없음, 10KB 제한)
    const toolContent={tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description}))};
    const body={displayName,interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],mcpServerSpec:{type:'TOOL_SPEC',content:toolContent}};
    console.log(`[AgentRegistry] POST ${loc}/services?serviceId=${serviceId} — TOOL_SPEC content (${ALL_TOOLS.length}도구)`);
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