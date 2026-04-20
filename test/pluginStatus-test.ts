import chai from 'chai'
import { composeStatus } from '../src/pluginStatus'

const expect = chai.expect

describe('composeStatus', () => {
  it('handles a single path with charts', () => {
    expect(
      composeStatus([{ chartPath: '/home/user/.signalk/charts', count: 5 }], 0)
    ).to.equal('Started - Found 5 charts from /home/user/.signalk/charts')
  })

  it('addresses issue #8: reports 0 charts found from the configured path', () => {
    expect(
      composeStatus([{ chartPath: '/home/jduno/.signalk/charts', count: 0 }], 0)
    ).to.equal('Started - Found 0 charts from /home/jduno/.signalk/charts')
  })

  it('uses singular form when exactly one chart is found', () => {
    expect(composeStatus([{ chartPath: '/a', count: 1 }], 0)).to.equal(
      'Started - Found 1 chart from /a'
    )
  })

  it('lists per-path counts when multiple paths are configured', () => {
    expect(
      composeStatus(
        [
          { chartPath: '/a', count: 2 },
          { chartPath: '/b', count: 3 }
        ],
        0
      )
    ).to.equal('Started - Found 5 charts: /a (2), /b (3)')
  })

  it('includes online provider count when present', () => {
    expect(composeStatus([{ chartPath: '/a', count: 4 }], 2)).to.equal(
      'Started - Found 4 charts from /a + 2 online providers'
    )
  })

  it('uses singular "provider" for a single online provider', () => {
    expect(composeStatus([{ chartPath: '/a', count: 4 }], 1)).to.equal(
      'Started - Found 4 charts from /a + 1 online provider'
    )
  })

  it('omits online part when no online providers are configured', () => {
    expect(composeStatus([{ chartPath: '/a', count: 4 }], 0)).to.equal(
      'Started - Found 4 charts from /a'
    )
  })

  it('handles the empty case with no paths and no online providers', () => {
    expect(composeStatus([], 0)).to.equal('Started - Found 0 charts')
  })

  it('handles no paths but some online providers', () => {
    expect(composeStatus([], 3)).to.equal(
      'Started - Found 0 charts + 3 online providers'
    )
  })

  it('preserves path order in the breakdown', () => {
    expect(
      composeStatus(
        [
          { chartPath: '/zzz', count: 1 },
          { chartPath: '/aaa', count: 1 }
        ],
        0
      )
    ).to.equal('Started - Found 2 charts: /zzz (1), /aaa (1)')
  })
})
