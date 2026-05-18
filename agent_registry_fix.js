  // ★ Agent Registry 직접 조회
  if (name==='agent_registry_list') {
    const loc=args.location||GCP_REGION;
    const results={};
    const r1=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${project}/locations/${loc}/services`,{headers:{Authorization:`Bearer ${token}`}});
    const t1=await r1.text();
    results[loc]={status:r1.status,ok:r1.ok,data:r1.ok?(()=>{try{return JSON.parse(t1);}catch{return t1;}})():t1};
    if (loc!=='global') {
      const r2=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${project}/locations/global/services`,{headers:{Authorization:`Bearer ${token}`}});
      const t2=await r2.text();
      results['global']={status:r2.status,ok:r2.ok,data:r2.ok?(()=>{try{return JSON.parse(t2);}catch{return t2;}})():t2};
    }
    return results;
  }

  // ★ Agent Registry 직접 등록 (올바른 스키마: url 필드 + serviceId 쿼리 파라미터)
  if (name==='agent_registry_register') {
    const loc=args.location||GCP_REGION;
    const endpointUrl=args.endpoint_url||`${MCP_URL}/mcp`;
    const displayName=args.display_name||'ASTERION AI Evolution Engine';
    const serviceId=args.service_id||'asterion-mcp';
    // Discovery API 확인: Interface 필드명은 'url' (endpointUri 아님)
    // mcpServerSpec 포함시 MCP Server로 분류됨
    const body={
      displayName,
      interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],
      mcpServerSpec:{type:'NO_SPEC'}
    };
    console.log(`[AgentRegistry] POST locations/${loc}/services?serviceId=${serviceId} — ${endpointUrl}`);
    const r=await fetch(`https://agentregistry.googleapis.com/v1alpha/projects/${project}/locations/${loc}/services?serviceId=${serviceId}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const text=await r.text();
    let parsed;
    try { parsed=JSON.parse(text); } catch { parsed=text; }
    // Long-running Operation 반환 — done=true면 완료
    if (r.ok && parsed.name) {
      // Operation 폴링 (최대 10회)
      let opResult=parsed;
      for (let i=0;i<10&&!opResult.done;i++) {
        await new Promise(res=>setTimeout(res,2000));
        const pr=await fetch(`https://agentregistry.googleapis.com/v1alpha/${opResult.name}`,{headers:{Authorization:`Bearer ${token}`}});
        if (pr.ok) opResult=await pr.json();
      }
      return {status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,protocolBinding:'JSONRPC',serviceId,operation:opResult};
    }
    return {status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,protocolBinding:'JSONRPC',serviceId,response:parsed};
  }