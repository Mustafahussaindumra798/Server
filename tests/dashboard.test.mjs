import test from "node:test";
import assert from "node:assert/strict";
import {initialState,pageMeta,escapeHtml,filterRecords,getNodeResources} from "../app.js";
test("all dashboard sections are defined",()=>{for(const page of ["overview","nodes","applications","deployments","network","activity","settings"])assert.ok(pageMeta[page])});
test("demo inventory contains nodes, apps, deployments and routes",()=>{assert.equal(initialState.nodes.length,4);assert.equal(initialState.apps.length,6);assert.ok(initialState.deployments.length);assert.ok(initialState.routes.length)});
test("dynamic HTML values are escaped",()=>assert.equal(escapeHtml("<script title='x'>&</script>"),"&lt;script title=&#39;x&#39;&gt;&amp;&lt;/script&gt;"));
test("search is case insensitive and restricted to chosen fields",()=>{assert.equal(filterRecords(initialState.nodes,"ANDROID",["name","platform"]).length,2);assert.equal(filterRecords(initialState.nodes,"missing",["name"]).length,0)});
test("node resources are derived from inventory",()=>assert.equal(getNodeResources(initialState.nodes[0]),"4 cores · 4 GB"));
