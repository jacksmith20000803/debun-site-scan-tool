"use client";
import _ from 'lodash';
export default function Page() { return <main><h1>{_.kebabCase('Turbopack audit fixture')}</h1><button onClick={() => _.uniq([1,1,2])}>inspect</button></main> }
