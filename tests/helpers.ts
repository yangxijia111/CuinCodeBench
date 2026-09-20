import type { ProblemInput } from '../src/shared/types'

/** 通用测试夹具：标准题目输入（3 个用例，三语言初始代码） */
export function makeProblemInput(overrides: Partial<ProblemInput> = {}): ProblemInput {
  return {
    title: '测试题 A+B',
    description: '输入两个整数，输出它们的和',
    difficulty: 'easy',
    tags: ['入门', '数学'],
    inputDesc: '一行两个整数',
    outputDesc: '一个整数',
    samples: [{ input: '1 2', output: '3' }],
    initialCode: {
      c: '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}',
      cpp: '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}',
      python: 'a, b = map(int, input().split())\nprint(a + b)'
    },
    testCases: [
      { stdin: '1 2', expectedStdout: '3', timeoutMs: 5000 },
      { stdin: '10 -3', expectedStdout: '7', timeoutMs: 5000 },
      { stdin: '', expectedStdout: '', timeoutMs: 5000 }
    ],
    ...overrides
  }
}
