import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Navigate,Route,Routes,useNavigate} from 'react-router-dom';
import './app.js';

const pagePaths={
  Overview:'/overview',
  'Sales & returns':'/sales-returns',
  Customers:'/customers',
  Tickets:'/tickets',
  'SMS centre':'/sms',
  'SMS API settings':'/sms/settings',
  'Campaign settings':'/campaign-settings',
  'Audit report':'/audit',
  Users:'/users',
  'My account':'/account'
};
const pathPages=Object.fromEntries(Object.entries(pagePaths).map(([page,path])=>[path,page]));

function SyncLegacyPage({page}){
  const navigate=useNavigate();
  useEffect(()=>{
    window.lotteryRouterNavigate=target=>navigate(pagePaths[target]||pagePaths.Overview);
    return ()=>{delete window.lotteryRouterNavigate;};
  },[navigate]);
  useEffect(()=>{window.lotteryRouterSetPage?.(page);},[page]);
  return null;
}

function AppRouter(){
  return <BrowserRouter><Routes>
    {Object.entries(pathPages).map(([path,page])=><Route key={path} path={path} element={<SyncLegacyPage page={page}/>}/>)}
    <Route path="*" element={<Navigate to="/overview" replace/>}/>
  </Routes></BrowserRouter>;
}

createRoot(document.getElementById('router-root')).render(<AppRouter/>);
