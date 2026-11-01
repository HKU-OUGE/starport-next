"""Project-side client. Reads only revocable project credentials from environment."""
import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

def request(route, body=None, binary=False):
    url=os.environ['STARPORT_COMPUTE_URL'].rstrip('/')
    token=os.environ['STARPORT_COMPUTE_TOKEN']
    req=urllib.request.Request(url+route, data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    # Project service stays on loopback, independently of external proxy settings.
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req,timeout=210) as response:
            value=response.read()
    except urllib.error.HTTPError as e:
        try: message=json.loads(e.read()).get('error','compute_request_failed')
        except Exception: message='compute_request_failed'
        raise RuntimeError(message) from None
    except (urllib.error.URLError,TimeoutError):
        raise RuntimeError('compute_unavailable' if body is None else 'compute_outcome_unknown_check_before_retry') from None
    return value if binary else json.loads(value)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    sub=p.add_subparsers(dest='action',required=True)
    for name in ['health','jobs']: sub.add_parser(name)
    submit=sub.add_parser('submit')
    submit.add_argument('entry');submit.add_argument('--file',action='append',default=[])
    submit.add_argument('--cpus',type=int,default=1);submit.add_argument('--memory-gib',type=int,default=2)
    submit.add_argument('--gpus',type=int,default=0);submit.add_argument('--timeout',type=int,default=120)
    submit.add_argument('--language',choices=['python','bash'],default='python')
    submit.add_argument('--arg',action='append',default=[])
    for name in ['status','logs','cancel','download']:
        child=sub.add_parser(name);child.add_argument('job')
        if name=='logs':child.add_argument('--cursor',type=int,default=0)
        if name=='download':child.add_argument('artifact');child.add_argument('output')
    a=p.parse_args()
    if a.action in ['health','jobs']:result=request('/'+a.action)
    elif a.action=='submit':
        root=pathlib.Path.cwd().resolve();files={}
        for name in dict.fromkeys([a.entry,*a.file]):
            file=pathlib.Path(name)
            if file.is_absolute() or '..' in file.parts or not file.resolve().is_relative_to(root):raise RuntimeError('project_relative_file_required')
            if not file.is_file() or file.stat().st_size>16*1024*1024:raise RuntimeError('invalid_job_file')
            files[file.as_posix()]=base64.b64encode(file.read_bytes()).decode()
        result=request('/jobs',{'entry':pathlib.Path(a.entry).as_posix(),'files':files,'args':a.arg,
            'cpus':a.cpus,'memory_gib':a.memory_gib,'gpus':a.gpus,'timeout':a.timeout,'language':a.language})
    else:
        import re
        if not re.fullmatch('[a-f0-9]{32}',a.job):raise RuntimeError('invalid_job_id')
        route='/jobs/'+a.job
        if a.action=='status':result=request(route)
        elif a.action=='logs':result=request(route+'/logs?cursor='+str(a.cursor))
        elif a.action=='cancel':result=request(route+'/cancel',{})
        else:
            from urllib.parse import quote
            body=request(route+'/artifact/'+quote(a.artifact,safe='/'),binary=True)
            # Explicit output is a project file; refuse to overwrite an existing result.
            with open(a.output,'xb') as f:f.write(body)
            import hashlib
            result={'saved':a.output,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as e:
        message=str(e)
        import re
        print(json.dumps({'error':message if re.fullmatch('[a-z][a-z0-9_]{1,79}',message) else 'compute_client_failed'}))
        sys.exit(1)
