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

  // ★ Agent Registry 직접 등록
  // Discovery API 확인: Interface.url (endpointUri 아님), serviceId 쿼리 파라미터 필수
  if (name==='agent_registry_register') {
    const loc=args.location||GCP_REGION;
    const endpointUrl=args.endpoint_url||`${MCP_URL}/mcp`;
    const displayName=args.display_name||'ASTERION AI Evolution Engine';
    const serviceId=args.service_id||'asterion-mcp';
    const body={
      displayName,
      interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],
      mcpServerSpec:{type:'NO_SPEC'}
    };
    console.log(`[AgentRegistry] POST ${loc}/services?serviceId=${serviceId} — ${endpointUrl}`);
    const r=await fetch(
      `https://agentregistry.googleapis.com/v1alpha/projects/${project}/locations/${loc}/services?serviceId=${serviceId}`,
      {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)}
    );
    const text=await r.text();
    let parsed; try { parsed=JSON.parse(text); } catch { parsed=text; }
    // Long-running Operation 폴링
    if (r.ok && parsed.name) {
      let op=parsed;
      for (let i=0;i<15&&!op.done;i++) {
        await new Promise(res=>setTimeout(res,2000));
        const pr=await fetch(`https://agentregistry.googleapis.com/v1alpha/${op.name}`,{headers:{Authorization:`Bearer ${token}`}});
        if (pr.ok) op=await pr.json();
      }
      return {status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,operation_done:op.done,operation_error:op.error,result:op.response||op};
    }
    return {status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,response:parsed};
  }