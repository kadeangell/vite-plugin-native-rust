import { get, route } from 'remix/routes'

export const routes = route({
  home: get('/'),
  rustJson: get('/api/rust'),
})
