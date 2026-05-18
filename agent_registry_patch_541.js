    // ALL_TOOLS → TOOL_SPEC content (inputSchema 필수, 10KB 제한으로 최소 형식)
    const toolContent={tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema||{type:'object'}}))};
    const body={displayName,interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],mcpServerSpec:{type:'TOOL_SPEC',content:toolContent}};