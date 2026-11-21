const state = {
  nodes: [
    {id:"node-01",name:"android-node-01",platform:"Android / Termux",resources:"4 cores · 4 GB",status:"Online",icon:"▣"},
    {id:"node-02",name:"ubuntu-node-01",platform:"Ubuntu Linux",resources:"2 cores · 4 GB",status:"Online",icon:"◈"},
    {id:"node-03",name:"android-node-02",platform:"Android / Termux",resources:"8 cores · 4 GB",status:"Online",icon:"▣"},
    {id:"node-04",name:"windows-node-01",platform:"Windows",resources:"4 cores · 8 GB",status:"Offline",icon:"▦"}
  ],
  apps: [
    {name:"Cloudexify Website",stack:"Next.js · node-01",symbol:"C",status:"Running"},
    {name:"API Gateway",stack:"Node.js · ubuntu-node-01",symbol:"⌁",status:"Running"},
    {name:"Internship Portal",stack:"React · node-03",symbol:"I",status:"Running"},
    {name:"ToolForge",stack:"Vite · ubuntu-node-01",symbol:"T",status:"Running"},
    {name:"Analytics Worker",stack:"Node.js · node-02",symbol:"A",status:"Stopped"},
    {name:"Preview App",stack:"Static · unassigned",symbol:"P",status:"Stopped"}
  ],
  activity: [
    ["✓","Node heartbeat received","android-node-01 · simulated","2 min ago"],
    ["⇧","Deployment completed","Cloudexify Website · demo","18 min ago"],
    ["＋","Node registered","ubuntu-node-01 · simulated","1 hour ago"],
    ["◉","Health check passed","API Gateway · demo","2 hours ago"]
  ]
};
const $ = (selector) => document.querySelector(selector);
function renderNodes(){
  $("#node-table").innerHTML = state.nodes.slice(0,4).map(n => `<tr><td><div class="node-name"><span class="node-icon">${n.icon}</span><span>${escapeHtml(n.name)}<small>${escapeHtml(n.id)}</small></span></div></td><td>${escapeHtml(n.platform)}</td><td><span class="resource">${escapeHtml(n.resources)}</span></td><td><span class="status ${n.status==="Online"?"":"offline"}">${n.status}</span></td><td>···</td></tr>`).join("");
  $("#metric-nodes").innerHTML = `${state.nodes.filter(n=>n.status==="Online").length} <small>/ ${state.nodes.length}</small>`;
  $("#nav-node-count").textContent=state.nodes.length;
}
function renderApps(){
  $("#app-grid").innerHTML=state.apps.map(a=>`<div class="app-card"><div class="app-logo">${escapeHtml(a.symbol)}</div><div class="app-meta"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(a.stack)}</small></div><span class="app-state ${a.status==="Running"?"":"stopped"}">${a.status}</span></div>`).join("");
  $("#metric-apps").innerHTML=`${state.apps.filter(a=>a.status==="Running").length} <small>/ ${state.apps.length}</small>`;
}
function renderActivity(){
  $("#activity-list").innerHTML=state.activity.slice(0,4).map(a=>`<div class="activity-item"><span class="activity-symbol">${a[0]}</span><div><b>${escapeHtml(a[1])}</b><p>${escapeHtml(a[2])}</p><time>${escapeHtml(a[3])}</time></div></div>`).join("");
}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
let toastTimer;
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600);}
function addActivity(title,detail){state.activity.unshift(["＋",title,detail,"Just now"]);renderActivity();}
function registerNode(event){
  event.preventDefault();
  const form=new FormData(event.currentTarget);
  const name=String(form.get("name")||"").trim();
  if(!name){toast("Enter a node name.");return;}
  if(state.nodes.some(n=>n.name.toLowerCase()===name.toLowerCase())){toast("A node with this name already exists.");return;}
  const memory=String(form.get("memory"));
  const id="node-"+String(state.nodes.length+1).padStart(2,"0");
  state.nodes.push({id,name,platform:String(form.get("platform")),resources:"4 cores · "+memory,status:"Online",icon:"▤"});
  renderNodes();addActivity("Sample node registered",name+" · simulation");
  $("#node-dialog").close();event.currentTarget.reset();toast("Sample node added. No real device was connected.");
}
function navigate(page){
  const labels={overview:"Overview",nodes:"Compute nodes",applications:"Applications",deployments:"Deployments",network:"Network & routing",activity:"Activity log",settings:"Settings"};
  const label=labels[page]||"Overview";
  $("#breadcrumb-page").textContent=label;$("#page-title").textContent=page==="overview"?"Infrastructure overview":label;
  $("#page-subtitle").textContent=page==="overview"?"Monitor your devices and hosted applications from one place.": "Explore "+label.toLowerCase()+" in the Cloudexify prototype.";
  document.querySelectorAll(".nav-link").forEach(link=>link.classList.toggle("active",link.dataset.page===page));
  if(page!=="overview")toast(label+" view is a prototype placeholder; dashboard data remains simulated.");
  $("#sidebar").classList.remove("open");
}
$("#node-form").addEventListener("submit",registerNode);
$("#add-node-btn").addEventListener("click",()=>$("#node-dialog").showModal());
$("#dismiss-notice").addEventListener("click",()=>$(".notice").remove());
$("#menu-btn").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
document.querySelectorAll("[data-page]").forEach(link=>link.addEventListener("click",()=>navigate(link.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(button=>button.addEventListener("click",()=>navigate(button.dataset.goto)));
window.addEventListener("hashchange",()=>navigate(location.hash.slice(1)||"overview"));
renderNodes();renderApps();renderActivity();
