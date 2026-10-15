import { expect, test, vi } from "vitest";
import { OpenAICompatibleClient, interactiveQueryReasoningProfile, generationRequestBody } from "../src/providers/openai-compatible.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import type { Executor } from "../src/runner/executor.js";
import { toolQuerySystemInstructionsFor } from "../src/prompts/contracts.js";

const baseURL="https://openrouter.ai/api/v1", model="deepseek/deepseek-v4.1-flash";
const interactive={egress:{purpose:"interactive" as const,dataClass:"restricted" as const}};
test.each(["prompt/intent-routing/v1","prompt/query/v6","prompt/conversation/v1"])("Qwen current interactive %s is explicitly bounded non-thinking",async template=>{
  const fetchImplementation=vi.fn<typeof fetch>(async(_url,init)=>{const wire=JSON.parse(String(init?.body));expect(wire.reasoning).toEqual({enabled:false});expect(wire.model).toBe("qwen/qwen3.8-flash");return Response.json({choices:[{finish_reason:"stop",message:{content:"Confirmed"}}]});});
  const client=new OpenAICompatibleClient({baseURL,apiKey:"synthetic-test-key",model:"qwen/qwen3.8-flash",fetchImplementation});
  await client.queryWithTools([{role:"user",content:"Explain"}],[],{promptTemplateVersion:template,context:interactive,maxOutputTokens:900});
  expect(interactiveQueryReasoningProfile(baseURL,"qwen/qwen3.8-flash",{promptTemplateVersion:template,context:interactive})).toBe("openrouter-qwen-interactive-fast/v1");
});
test("only Qwen's current interactive candidate contract changes generation sampling",()=>{
  expect(generationRequestBody(baseURL,"qwen/qwen3.8-flash",0,"candidate",{promptTemplateVersion:"prompt/candidate/v21",...interactive}).reasoning).toEqual({enabled:false});
  expect(generationRequestBody(baseURL,"qwen/qwen3.8-flash",0,"candidate",{promptTemplateVersion:"prompt/candidate/v20",...interactive})).not.toHaveProperty("reasoning");
  expect(generationRequestBody(baseURL,"qwen/qwen3.8-flash",0,"runtime",{promptTemplateVersion:"prompt/candidate/v21",egress:{purpose:"runtime_analysis",dataClass:"internal"}})).not.toHaveProperty("reasoning");
});
test.each(["prompt/intent-routing/v1","prompt/conversation/v1","prompt/workflow-discussion/v1","prompt/query/v6","prompt/action/v5"])("current interactive %s explicitly disables optional provider thinking, without changing model or tools",async template=>{
  const fetchImplementation=vi.fn<typeof fetch>(async(_url,init)=>{
    const wire=JSON.parse(String(init?.body)); expect(wire.reasoning).toEqual({enabled:false});expect(wire.model).toBe(model);expect(wire.max_tokens).toBe(900);
    expect(wire.tools).toBeUndefined(); return Response.json({choices:[{finish_reason:"stop",message:{content:"Confirmed answer"}}]});
  });
  const client=new OpenAICompatibleClient({baseURL,apiKey:"synthetic-test-key",model,fetchImplementation});
  expect((await client.queryWithTools([{role:"user",content:"Explain briefly"}],[],{promptTemplateVersion:template,maxOutputTokens:900,context:interactive})).text).toBe("Confirmed answer");
  expect(fetchImplementation).toHaveBeenCalledOnce();
});
test.each([
  {baseURL:"https://other.example.test/v1"},{model:"another/model"},{purpose:"runtime_agent"},{purpose:"runtime_analysis"},
  {purpose:undefined},{template:"prompt/query/v5"},{template:"prompt/runtime-agent/v1"},{template:undefined},
])("unreviewed endpoints/models, old prompts and runtime requests never inherit interactive fast sampling: %j",change=>{
  const template="template" in change?change.template:"prompt/query/v6";
  expect(interactiveQueryReasoningProfile(change.baseURL??baseURL,change.model??model,{
    ...(template?{promptTemplateVersion:template}:{}),
    context:"purpose" in change?change.purpose?{egress:{purpose:change.purpose as "runtime_agent"|"runtime_analysis",dataClass:"restricted"}}:{}:interactive,
  })).toBeUndefined();
});
test("generation and reviewed runtime request bodies do not silently inherit the new query policy",()=>{
  expect(generationRequestBody(baseURL,model,0,"candidate",{promptTemplateVersion:"prompt/candidate/v21",...interactive})).not.toHaveProperty("reasoning");
});
test("inference provenance records the actual fast profile, without storing the key or granting ERP access",async()=>{
  const repository=await Repository.open(null),executor={setAnalysisProvider:vi.fn()} as unknown as Executor;
  const transport=vi.fn<typeof fetch>(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"Brief answer"}}],usage:{prompt_tokens:5,completion_tokens:3}}));
  const runtime=new ProviderRuntime(repository,executor,transport);
  runtime.activate({id:"fast",name:"Fast",type:"openai_compatible",baseURL,apiKey:"synthetic-private-key",model,temperature:0,timeoutMs:1000,
    egressPolicy:{profile:"model-egress-policy/v1",approvedOrigin:"https://openrouter.ai",interactiveDataClasses:["restricted"],runtimeAnalysisDataClasses:[],runtimeAgentDataClasses:[],reviewedAt:"2026-10-16T00:00:00Z",reviewedBy:{id:"admin",name:"Admin"}}});
  try{
    await runtime.queryWithTools([{role:"system",content:toolQuerySystemInstructionsFor("prompt/conversation/v1")!},{role:"user",content:"Explain"}],[],{promptTemplateVersion:"prompt/conversation/v1",context:interactive});
    const records=Object.values((await repository.snapshot()).invocationProvenance);
    expect(records).toHaveLength(1);expect(records[0]).toMatchObject({inferenceProfile:"openrouter-deepseek-interactive-fast/v1",status:"SUCCEEDED",model});
    expect(JSON.stringify(records)).not.toContain("synthetic-private-key");
  }finally{await repository.close();}
});
